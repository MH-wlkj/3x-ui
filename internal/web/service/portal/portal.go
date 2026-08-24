// Package portal backs the tenant portal: admin user management plus a
// token-authenticated API that lets each tenant create and manage clients on
// a restricted set of inbounds. Portal-created clients carry a group tag of
// "portal:<id>" so quota counting and ownership checks never touch other
// tenants' clients.
package portal

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/mhsanaei/3x-ui/v3/internal/database"
	"github.com/mhsanaei/3x-ui/v3/internal/database/model"
	"github.com/mhsanaei/3x-ui/v3/internal/util/common"
	"github.com/mhsanaei/3x-ui/v3/internal/util/crypto"
	"github.com/mhsanaei/3x-ui/v3/internal/web/service"
	"github.com/mhsanaei/3x-ui/v3/internal/xray"
)

// PortalService groups all portal operations. It is stateless apart from the
// in-memory token store, mirroring the panel's other service structs.
type PortalService struct{}

type portalSession struct {
	UserId    int
	ExpiresAt time.Time
}

var (
	sessionMu sync.Mutex
	sessions  = make(map[string]portalSession)
)

const tokenTTL = 24 * time.Hour

func groupTag(userId int) string {
	return fmt.Sprintf("portal:%d", userId)
}

func randomToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// ---- admin: user management ----

// PanelUserView augments a tenant account with live usage for the admin list.
type PanelUserView struct {
	Id           int    `json:"id"`
	Username     string `json:"username"`
	InboundIds   []int  `json:"inboundIds"`
	ClientLimit  int    `json:"clientLimit"`
	TrafficLimit int64  `json:"trafficLimit"`
	Enable       bool   `json:"enable"`
	CreatedAt    int64  `json:"createdAt"`
	UpdatedAt    int64  `json:"updatedAt"`
	UsedClients  int    `json:"usedClients"`
	UsedTraffic  int64  `json:"usedTraffic"`
}

// ListUsers returns all tenant accounts ordered by id with live usage.
func (s *PortalService) ListUsers() ([]PanelUserView, error) {
	var users []model.PanelUser
	if err := database.GetDB().Order("id ASC").Find(&users).Error; err != nil {
		return nil, err
	}
	views := make([]PanelUserView, 0, len(users))
	for i := range users {
		u := &users[i]
		used, _ := s.countClients(u)
		usedTraffic, _ := s.countUsedTraffic(u)
		views = append(views, PanelUserView{
			Id:           u.Id,
			Username:     u.Username,
			InboundIds:   u.InboundIds,
			ClientLimit:  u.ClientLimit,
			TrafficLimit: u.TrafficLimit,
			Enable:       u.Enable,
			CreatedAt:    u.CreatedAt,
			UpdatedAt:    u.UpdatedAt,
			UsedClients:  used,
			UsedTraffic:  usedTraffic,
		})
	}
	return views, nil
}

// CreateUser persists a new tenant account. An empty password is rejected; the
// stored value is always the bcrypt hash.
func (s *PortalService) CreateUser(username, password string, inboundIds []int, clientLimit int, trafficLimit int64, enable bool) error {
	if strings.TrimSpace(username) == "" {
		return common.NewError("username is required")
	}
	if strings.TrimSpace(password) == "" {
		return common.NewError("password is required")
	}
	hashed, err := crypto.HashPasswordAsBcrypt(password)
	if err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	u := &model.PanelUser{
		Username:     strings.TrimSpace(username),
		Password:     hashed,
		InboundIds:   inboundIds,
		ClientLimit:  clientLimit,
		TrafficLimit: trafficLimit,
		Enable:       enable,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	return database.GetDB().Create(u).Error
}

// UpdateUser edits a tenant account. A blank username/password leaves the
// existing value untouched.
func (s *PortalService) UpdateUser(id int, username, password string, inboundIds []int, clientLimit int, trafficLimit int64, enable bool) error {
	var u model.PanelUser
	if err := database.GetDB().First(&u, id).Error; err != nil {
		return err
	}
	if strings.TrimSpace(username) != "" {
		u.Username = strings.TrimSpace(username)
	}
	if strings.TrimSpace(password) != "" {
		hashed, err := crypto.HashPasswordAsBcrypt(password)
		if err != nil {
			return err
		}
		u.Password = hashed
	}
	u.InboundIds = inboundIds
	u.ClientLimit = clientLimit
	u.TrafficLimit = trafficLimit
	u.Enable = enable
	u.UpdatedAt = time.Now().UnixMilli()
	return database.GetDB().Save(&u).Error
}

// DeleteUser removes a tenant account. Existing portal clients keep their
// group tag but are no longer attributable to an account.
func (s *PortalService) DeleteUser(id int) error {
	return database.GetDB().Delete(&model.PanelUser{}, id).Error
}

// ---- portal auth ----

// Login validates a tenant's credentials and issues a bearer token.
func (s *PortalService) Login(username, password string) (string, error) {
	var u model.PanelUser
	if err := database.GetDB().Where("username = ?", username).First(&u).Error; err != nil {
		return "", common.NewError("invalid username or password")
	}
	if !u.Enable {
		return "", common.NewError("account is disabled")
	}
	if !crypto.CheckPasswordHash(u.Password, password) {
		return "", common.NewError("invalid username or password")
	}
	token := randomToken()
	sessionMu.Lock()
	sessions[token] = portalSession{UserId: u.Id, ExpiresAt: time.Now().Add(tokenTTL)}
	sessionMu.Unlock()
	return token, nil
}

// Logout invalidates a bearer token.
func (s *PortalService) Logout(token string) {
	sessionMu.Lock()
	delete(sessions, token)
	sessionMu.Unlock()
}

// UserByToken resolves a bearer token to an enabled tenant account.
func (s *PortalService) UserByToken(token string) (*model.PanelUser, error) {
	sessionMu.Lock()
	ses, ok := sessions[token]
	sessionMu.Unlock()
	if !ok || time.Now().After(ses.ExpiresAt) {
		if ok {
			sessionMu.Lock()
			delete(sessions, token)
			sessionMu.Unlock()
		}
		return nil, common.NewError("portal session expired")
	}
	var u model.PanelUser
	if err := database.GetDB().First(&u, ses.UserId).Error; err != nil {
		return nil, err
	}
	if !u.Enable {
		return nil, common.NewError("account is disabled")
	}
	return &u, nil
}

// ---- portal operations ----

// UserStatus is the tenant's quota view returned by /me.
type UserStatus struct {
	Id           int    `json:"id"`
	Username     string `json:"username"`
	InboundIds   []int  `json:"inboundIds"`
	ClientLimit  int    `json:"clientLimit"`
	TrafficLimit int64  `json:"trafficLimit"`
	UsedClients  int    `json:"usedClients"`
	UsedTraffic  int64  `json:"usedTraffic"`
}

// UserStatus reports how many of the tenant's allowed client slots are used
// and how much aggregate traffic their clients have consumed.
func (s *PortalService) UserStatus(user *model.PanelUser) (*UserStatus, error) {
	used, err := s.countClients(user)
	if err != nil {
		return nil, err
	}
	usedTraffic, err := s.countUsedTraffic(user)
	if err != nil {
		return nil, err
	}
	return &UserStatus{
		Id:           user.Id,
		Username:     user.Username,
		InboundIds:   user.InboundIds,
		ClientLimit:  user.ClientLimit,
		TrafficLimit: user.TrafficLimit,
		UsedClients:  used,
		UsedTraffic:  usedTraffic,
	}, nil
}

// countUsedTraffic sums up+down across the tenant's own clients.
func (s *PortalService) countUsedTraffic(user *model.PanelUser) (int64, error) {
	tag := groupTag(user.Id)
	var used int64
	err := database.GetDB().Model(&xray.ClientTraffic{}).
		Joins("JOIN clients ON clients.email = client_traffics.email AND clients.group_name = ?", tag).
		Select("COALESCE(SUM(client_traffics.up + client_traffics.down), 0)").
		Scan(&used).Error
	return used, err
}

// AllowedInbounds returns the subset of inbound options the tenant may target.
func (s *PortalService) AllowedInbounds(user *model.PanelUser, adminUserID int) ([]service.InboundOption, error) {
	options, err := (&service.InboundService{}).GetInboundOptions(adminUserID)
	if err != nil {
		return nil, err
	}
	allowed := make(map[int]bool, len(user.InboundIds))
	for _, id := range user.InboundIds {
		allowed[id] = true
	}
	out := make([]service.InboundOption, 0, len(user.InboundIds))
	for _, ib := range options {
		if allowed[ib.Id] {
			out = append(out, ib)
		}
	}
	return out, nil
}

// CreateClientRequest is the tenant-facing client creation payload. TotalGB is
// in bytes and ExpiryTime is a unix-millisecond timestamp (0 = never expires).
type CreateClientRequest struct {
	InboundId  int    `json:"inboundId"`
	Email      string `json:"email"`
	TotalGB    int64  `json:"totalGB"`
	ExpiryTime int64  `json:"expiryTime"`
	Flow       string `json:"flow"`
}

// CreateClient validates the target inbound and the quota, then creates one
// client tagged with the tenant's group.
func (s *PortalService) CreateClient(user *model.PanelUser, req *CreateClientRequest) (bool, error) {
	if !s.inboundAllowed(user, req.InboundId) {
		return false, common.NewError("inbound is not allowed for this account")
	}
	used, err := s.countClients(user)
	if err != nil {
		return false, err
	}
	if user.ClientLimit > 0 && used >= user.ClientLimit {
		return false, common.NewError("client limit reached")
	}
	if strings.TrimSpace(req.Email) == "" {
		return false, common.NewError("email is required")
	}
	client := model.Client{
		Email:      strings.TrimSpace(req.Email),
		TotalGB:    s.applyTrafficLimit(user, req.TotalGB),
		ExpiryTime: req.ExpiryTime,
		Flow:       req.Flow,
		Enable:     true,
		Group:      groupTag(user.Id),
	}
	payload := &service.ClientCreatePayload{
		Client:     client,
		InboundIds: []int{req.InboundId},
	}
	return (&service.ClientService{}).Create(&service.InboundService{}, payload)
}

// CreateClientsRequest carries a batch of client definitions for the portal
// generator (one inbound, many clients).
type CreateClientsRequest struct {
	InboundId int                  `json:"inboundId"`
	Clients   []CreateClientRequest `json:"clients"`
}

// CreateClients validates the inbound and quota once for the whole batch, then
// creates all clients tagged with the tenant's group.
func (s *PortalService) CreateClients(user *model.PanelUser, req *CreateClientsRequest) (service.BulkCreateResult, bool, error) {
	if !s.inboundAllowed(user, req.InboundId) {
		return service.BulkCreateResult{}, false, common.NewError("inbound is not allowed for this account")
	}
	if len(req.Clients) == 0 {
		return service.BulkCreateResult{}, false, common.NewError("no clients to create")
	}
	used, err := s.countClients(user)
	if err != nil {
		return service.BulkCreateResult{}, false, err
	}
	if user.ClientLimit > 0 && used+len(req.Clients) > user.ClientLimit {
		return service.BulkCreateResult{}, false, common.NewError(fmt.Sprintf("client limit reached: %d/%d", used, user.ClientLimit))
	}
	tag := groupTag(user.Id)
	payloads := make([]service.ClientCreatePayload, 0, len(req.Clients))
	for _, c := range req.Clients {
		if strings.TrimSpace(c.Email) == "" {
			continue
		}
		payloads = append(payloads, service.ClientCreatePayload{
			Client: model.Client{
				Email:      strings.TrimSpace(c.Email),
				TotalGB:    s.applyTrafficLimit(user, c.TotalGB),
				ExpiryTime: c.ExpiryTime,
				Flow:       c.Flow,
				Enable:     true,
				Group:      tag,
			},
			InboundIds: []int{req.InboundId},
		})
	}
	if len(payloads) == 0 {
		return service.BulkCreateResult{}, false, common.NewError("no valid clients to create")
	}
	return (&service.ClientService{}).BulkCreate(&service.InboundService{}, payloads)
}

// PortalClientView is one tenant-owned client for the /clients list.
type PortalClientView struct {
	Email      string `json:"email"`
	SubId      string `json:"subId"`
	InboundId  int    `json:"inboundId"`
	InboundTag string `json:"inboundTag"`
	Enable     bool   `json:"enable"`
	Up         int64  `json:"up"`
	Down       int64  `json:"down"`
	TotalGB    int64  `json:"totalGB"`
	ExpiryTime int64  `json:"expiryTime"`
	CreatedAt  int64  `json:"createdAt"`
}

// ListClients returns the tenant's own clients across their allowed inbounds.
func (s *PortalService) ListClients(user *model.PanelUser) ([]PortalClientView, error) {
	tag := groupTag(user.Id)
	inboundSvc := &service.InboundService{}
	views := []PortalClientView{}
	seen := map[string]bool{}
	for _, id := range user.InboundIds {
		inbound, err := inboundSvc.GetInbound(id)
		if err != nil {
			continue
		}
		clients, err := inboundSvc.GetClients(inbound)
		if err != nil {
			continue
		}
		for _, cl := range clients {
			if cl.Group != tag || seen[cl.Email] {
				continue
			}
			seen[cl.Email] = true
			view := PortalClientView{
				Email:      cl.Email,
				SubId:      cl.SubID,
				InboundId:  id,
				InboundTag: inbound.Tag,
				Enable:     cl.Enable,
				TotalGB:    cl.TotalGB,
				ExpiryTime: cl.ExpiryTime,
				CreatedAt:  cl.CreatedAt,
			}
			if tr, terr := inboundSvc.GetClientTrafficByEmail(cl.Email); terr == nil && tr != nil {
				view.Up = tr.Up
				view.Down = tr.Down
			}
			views = append(views, view)
		}
	}
	return views, nil
}

// DeleteClient removes one of the tenant's own clients by email.
func (s *PortalService) DeleteClient(user *model.PanelUser, email string) (bool, error) {
	inboundSvc := &service.InboundService{}
	if !s.ownsClient(user, email, inboundSvc) {
		return false, common.NewError("client not found for this account")
	}
	return (&service.ClientService{}).DeleteByEmail(inboundSvc, email, false)
}

// DeleteClients removes several of the tenant's own clients by email. Clients
// the tenant does not own are skipped. Returns how many were deleted.
func (s *PortalService) DeleteClients(user *model.PanelUser, emails []string) (int, error) {
	inboundSvc := &service.InboundService{}
	clientSvc := &service.ClientService{}
	deleted := 0
	for _, email := range emails {
		if strings.TrimSpace(email) == "" || !s.ownsClient(user, email, inboundSvc) {
			continue
		}
		if _, err := clientSvc.DeleteByEmail(inboundSvc, email, false); err != nil {
			continue
		}
		deleted++
	}
	return deleted, nil
}

// ChangePassword verifies the current password and stores the new hash.
func (s *PortalService) ChangePassword(user *model.PanelUser, oldPassword, newPassword string) error {
	if !crypto.CheckPasswordHash(user.Password, oldPassword) {
		return common.NewError("current password is incorrect")
	}
	if strings.TrimSpace(newPassword) == "" {
		return common.NewError("new password is required")
	}
	hashed, err := crypto.HashPasswordAsBcrypt(newPassword)
	if err != nil {
		return err
	}
	user.Password = hashed
	user.UpdatedAt = time.Now().UnixMilli()
	return database.GetDB().Save(user).Error
}

// ---- helpers ----

func (s *PortalService) inboundAllowed(user *model.PanelUser, inboundId int) bool {
	for _, id := range user.InboundIds {
		if id == inboundId {
			return true
		}
	}
	return false
}

func (s *PortalService) countClients(user *model.PanelUser) (int, error) {
	tag := groupTag(user.Id)
	inboundSvc := &service.InboundService{}
	emails := map[string]bool{}
	for _, id := range user.InboundIds {
		inbound, err := inboundSvc.GetInbound(id)
		if err != nil {
			continue
		}
		clients, err := inboundSvc.GetClients(inbound)
		if err != nil {
			continue
		}
		for _, cl := range clients {
			if cl.Group == tag {
				emails[cl.Email] = true
			}
		}
	}
	return len(emails), nil
}

func (s *PortalService) ownsClient(user *model.PanelUser, email string, inboundSvc *service.InboundService) bool {
	tag := groupTag(user.Id)
	for _, id := range user.InboundIds {
		inbound, err := inboundSvc.GetInbound(id)
		if err != nil {
			continue
		}
		clients, err := inboundSvc.GetClients(inbound)
		if err != nil {
			continue
		}
		for _, cl := range clients {
			if cl.Email == email && cl.Group == tag {
				return true
			}
		}
	}
	return false
}

// PortalClientLinks holds the share links and subscription link for one of the
// tenant's clients, used to render QR codes.
type PortalClientLinks struct {
	Links   []string `json:"links"`
	SubLink string   `json:"subLink"`
}

// ClientLinks returns the tenant's own client's share links plus its
// subscription link when subscriptions are enabled.
func (s *PortalService) ClientLinks(user *model.PanelUser, email, host string, settingSvc *service.SettingService) (*PortalClientLinks, error) {
	inboundSvc := &service.InboundService{}
	if !s.ownsClient(user, email, inboundSvc) {
		return nil, common.NewError("client not found for this account")
	}
	out := &PortalClientLinks{}
	var err error
	out.Links, err = inboundSvc.GetAllClientLinks(host, email)
	if err != nil {
		return nil, err
	}
	if subEnable, e := settingSvc.GetSubEnable(); e == nil && subEnable {
		if subURI, e2 := settingSvc.GetSubURI(); e2 == nil && subURI != "" {
			if subId, e3 := s.clientSubId(user, email, inboundSvc); e3 == nil && subId != "" {
				out.SubLink = subURI + subId
			}
		}
	}
	return out, nil
}

func (s *PortalService) clientSubId(user *model.PanelUser, email string, inboundSvc *service.InboundService) (string, error) {
	tag := groupTag(user.Id)
	for _, id := range user.InboundIds {
		inbound, err := inboundSvc.GetInbound(id)
		if err != nil {
			continue
		}
		clients, err := inboundSvc.GetClients(inbound)
		if err != nil {
			continue
		}
		for _, cl := range clients {
			if cl.Email == email && cl.Group == tag {
				return cl.SubID, nil
			}
		}
	}
	return "", common.NewError("client not found")
}

// applyTrafficLimit caps a per-client traffic value at the tenant's limit and
// uses the limit as the default when the client requests unlimited.
func (s *PortalService) applyTrafficLimit(user *model.PanelUser, totalGB int64) int64 {
	if user.TrafficLimit <= 0 {
		return totalGB
	}
	if totalGB <= 0 || totalGB > user.TrafficLimit {
		return user.TrafficLimit
	}
	return totalGB
}

// PortalXrayApplyRequest carries generated outbound and routing rules to merge
// into the panel's Xray config. Routing rules may only reference the tenant's
// own client emails, so a tenant can never capture another tenant's traffic.
type PortalXrayApplyRequest struct {
	Outbounds []map[string]any `json:"outbounds"`
	Routing   []map[string]any `json:"routing"`
}

// ApplyXray merges the tenant's generated outbounds and routing rules into the
// panel's Xray config and hot-reloads the running core. Routing rules are
// validated so they can only target the tenant's own clients.
func (s *PortalService) ApplyXray(user *model.PanelUser, req *PortalXrayApplyRequest, settingSvc *service.SettingService, xraySettingSvc *service.XraySettingService, xraySvc *service.XrayService) error {
	if len(req.Outbounds) == 0 && len(req.Routing) == 0 {
		return common.NewError("nothing to apply")
	}
	allowed, err := s.ownClientEmails(user)
	if err != nil {
		return err
	}
	for _, rule := range req.Routing {
		users, ok := rule["user"].([]any)
		if !ok || len(users) == 0 {
			return common.NewError("routing rule must carry a user list")
		}
		for _, u := range users {
			email, _ := u.(string)
			if !allowed[email] {
				return common.NewError("routing rule references a client that is not yours")
			}
		}
		if _, ok := rule["outboundTag"].(string); !ok {
			return common.NewError("routing rule must carry an outboundTag")
		}
	}
	cfgStr, err := settingSvc.GetXrayConfigTemplate()
	if err != nil {
		return err
	}
	var cfg map[string]any
	if err := json.Unmarshal([]byte(cfgStr), &cfg); err != nil {
		return err
	}
	outbounds, _ := cfg["outbounds"].([]any)
	rules, _ := cfg["routing"].(map[string]any)
	ruleList, _ := rules["rules"].([]any)

	existingTags := map[string]bool{}
	for _, ob := range outbounds {
		if m, ok := ob.(map[string]any); ok {
			if t, _ := m["tag"].(string); t != "" {
				existingTags[t] = true
			}
		}
	}
	added := 0
	for _, ob := range req.Outbounds {
		tag, _ := ob["tag"].(string)
		if tag == "" || existingTags[tag] {
			continue
		}
		outbounds = append(outbounds, ob)
		existingTags[tag] = true
		added++
	}
	existingRuleTags := map[string]bool{}
	for _, r := range ruleList {
		if m, ok := r.(map[string]any); ok {
			if t, _ := m["outboundTag"].(string); t != "" {
				existingRuleTags[t] = true
			}
		}
	}
	addedRules := 0
	for _, rule := range req.Routing {
		tag, _ := rule["outboundTag"].(string)
		if tag == "" || existingRuleTags[tag] {
			continue
		}
		ruleList = append(ruleList, rule)
		existingRuleTags[tag] = true
		addedRules++
	}
	if rules == nil {
		rules = map[string]any{}
	}
	rules["rules"] = ruleList
	cfg["outbounds"] = outbounds
	cfg["routing"] = rules
	merged, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := xraySettingSvc.SaveXraySetting(string(merged)); err != nil {
		return err
	}
	if xraySvc.IsXrayRunning() {
		if err := xraySvc.RestartXray(false); err != nil {
			return err
		}
	}
	_ = added
	_ = addedRules
	return nil
}

// ownClientEmails returns the set of client emails that belong to the tenant.
func (s *PortalService) ownClientEmails(user *model.PanelUser) (map[string]bool, error) {
	tag := groupTag(user.Id)
	var emails []string
	if err := database.GetDB().Model(&model.ClientRecord{}).Where("group_name = ?", tag).Pluck("email", &emails).Error; err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(emails))
	for _, e := range emails {
		out[e] = true
	}
	return out, nil
}

// UpdateClient edits one of the tenant's own clients' basic fields. The group
// tag is forced so ownership can never be reassigned, and an omitted flow is
// preserved so a partial update never strips XTLS Vision from a VLESS client.
func (s *PortalService) UpdateClient(user *model.PanelUser, email string, updated *model.Client) (bool, error) {
	inboundSvc := &service.InboundService{}
	if !s.ownsClient(user, email, inboundSvc) {
		return false, common.NewError("client not found for this account")
	}
	if updated.Flow == "" {
		if cl, ok := s.findClient(user, email, inboundSvc); ok {
			updated.Flow = cl.Flow
		}
	}
	updated.Group = groupTag(user.Id)
	return (&service.ClientService{}).UpdateByEmail(inboundSvc, email, *updated)
}

// findClient returns one of the tenant's own clients by email.
func (s *PortalService) findClient(user *model.PanelUser, email string, inboundSvc *service.InboundService) (model.Client, bool) {
	tag := groupTag(user.Id)
	for _, id := range user.InboundIds {
		inbound, err := inboundSvc.GetInbound(id)
		if err != nil {
			continue
		}
		clients, err := inboundSvc.GetClients(inbound)
		if err != nil {
			continue
		}
		for _, cl := range clients {
			if cl.Email == email && cl.Group == tag {
				return cl, true
			}
		}
	}
	return model.Client{}, false
}

// PortalNodeView is the outbound node (upstream proxy target) for one of the
// tenant's clients.
type PortalNodeView struct {
	Address string `json:"address"`
	Port    int    `json:"port"`
	User    string `json:"user"`
	Pass    string `json:"pass"`
}

// ClientNode returns the outbound node target for one of the tenant's clients.
func (s *PortalService) ClientNode(user *model.PanelUser, email string, settingSvc *service.SettingService) (*PortalNodeView, error) {
	if !s.ownsClient(user, email, &service.InboundService{}) {
		return nil, common.NewError("client not found for this account")
	}
	cfg, err := loadXrayConfig(settingSvc)
	if err != nil {
		return nil, err
	}
	outbounds, _ := cfg["outbounds"].([]any)
	for _, ob := range outbounds {
		m, ok := ob.(map[string]any)
		if !ok {
			continue
		}
		tag, _ := m["tag"].(string)
		if tag != email {
			continue
		}
		settings, _ := m["settings"].(map[string]any)
		servers, _ := settings["servers"].([]any)
		if len(servers) == 0 {
			return nil, common.NewError("outbound has no server")
		}
		srv, _ := servers[0].(map[string]any)
		view := &PortalNodeView{}
		view.Address, _ = srv["address"].(string)
		if p, ok := srv["port"].(float64); ok {
			view.Port = int(p)
		}
		users, _ := srv["users"].([]any)
		if len(users) > 0 {
			if u, ok := users[0].(map[string]any); ok {
				view.User, _ = u["user"].(string)
				view.Pass, _ = u["pass"].(string)
			}
		}
		return view, nil
	}
	return nil, common.NewError("outbound not found for this client")
}

// PortalNodeUpdateRequest edits the outbound node target (address/port/creds)
// for one of the tenant's clients. The routing rule keeps routing the client's
// email to the same outbound tag, so only the node target changes.
type PortalNodeUpdateRequest struct {
	Email   string `json:"email"`
	Address string `json:"address"`
	Port    int    `json:"port"`
	User    string `json:"user"`
	Pass    string `json:"pass"`
}

// UpdateClientNode updates the outbound node target for one of the tenant's
// clients and hot-reloads the running core.
func (s *PortalService) UpdateClientNode(user *model.PanelUser, req *PortalNodeUpdateRequest, settingSvc *service.SettingService, xraySettingSvc *service.XraySettingService, xraySvc *service.XrayService) error {
	if !s.ownsClient(user, req.Email, &service.InboundService{}) {
		return common.NewError("client not found for this account")
	}
	if strings.TrimSpace(req.Address) == "" {
		return common.NewError("address is required")
	}
	cfg, err := loadXrayConfig(settingSvc)
	if err != nil {
		return err
	}
	outbounds, _ := cfg["outbounds"].([]any)
	found := false
	for _, ob := range outbounds {
		m, ok := ob.(map[string]any)
		if !ok {
			continue
		}
		tag, _ := m["tag"].(string)
		if tag != req.Email {
			continue
		}
		settings, ok := m["settings"].(map[string]any)
		if !ok {
			return common.NewError("outbound has no settings")
		}
		servers, _ := settings["servers"].([]any)
		if len(servers) == 0 {
			return common.NewError("outbound has no server")
		}
		srv, ok := servers[0].(map[string]any)
		if !ok {
			return common.NewError("outbound server malformed")
		}
		srv["address"] = req.Address
		if req.Port > 0 {
			srv["port"] = req.Port
		}
		users, _ := srv["users"].([]any)
		if len(users) > 0 {
			if u, ok := users[0].(map[string]any); ok {
				if req.User != "" {
					u["user"] = req.User
				}
				if req.Pass != "" {
					u["pass"] = req.Pass
				}
			}
		}
		servers[0] = srv
		settings["servers"] = servers
		m["settings"] = settings
		found = true
		break
	}
	if !found {
		return common.NewError("outbound not found for this client")
	}
	merged, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := xraySettingSvc.SaveXraySetting(string(merged)); err != nil {
		return err
	}
	if xraySvc.IsXrayRunning() {
		if err := xraySvc.RestartXray(false); err != nil {
			return err
		}
	}
	return nil
}

// loadXrayConfig parses the panel's current Xray config template into a map.
func loadXrayConfig(settingSvc *service.SettingService) (map[string]any, error) {
	cfgStr, err := settingSvc.GetXrayConfigTemplate()
	if err != nil {
		return nil, err
	}
	var cfg map[string]any
	if err := json.Unmarshal([]byte(cfgStr), &cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}
