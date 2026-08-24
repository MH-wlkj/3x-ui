// Package portal backs the tenant portal: admin user management plus a
// token-authenticated API that lets each tenant create and manage clients on
// a restricted set of inbounds. Portal-created clients carry a group tag of
// "portal:<id>" so quota counting and ownership checks never touch other
// tenants' clients.
package portal

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/mhsanaei/3x-ui/v3/internal/database"
	"github.com/mhsanaei/3x-ui/v3/internal/database/model"
	"github.com/mhsanaei/3x-ui/v3/internal/util/common"
	"github.com/mhsanaei/3x-ui/v3/internal/util/crypto"
	"github.com/mhsanaei/3x-ui/v3/internal/web/service"
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

// ListUsers returns all tenant accounts ordered by id.
func (s *PortalService) ListUsers() ([]model.PanelUser, error) {
	var users []model.PanelUser
	if err := database.GetDB().Order("id ASC").Find(&users).Error; err != nil {
		return nil, err
	}
	return users, nil
}

// CreateUser persists a new tenant account. An empty password is rejected; the
// stored value is always the bcrypt hash.
func (s *PortalService) CreateUser(username, password string, inboundIds []int, clientLimit int, enable bool) error {
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
		Username:    strings.TrimSpace(username),
		Password:    hashed,
		InboundIds:  inboundIds,
		ClientLimit: clientLimit,
		Enable:      enable,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	return database.GetDB().Create(u).Error
}

// UpdateUser edits a tenant account. A blank username/password leaves the
// existing value untouched.
func (s *PortalService) UpdateUser(id int, username, password string, inboundIds []int, clientLimit int, enable bool) error {
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
	Id          int    `json:"id"`
	Username    string `json:"username"`
	InboundIds  []int  `json:"inboundIds"`
	ClientLimit int    `json:"clientLimit"`
	UsedClients int    `json:"usedClients"`
}

// UserStatus reports how many of the tenant's allowed client slots are used.
func (s *PortalService) UserStatus(user *model.PanelUser) (*UserStatus, error) {
	used, err := s.countClients(user)
	if err != nil {
		return nil, err
	}
	return &UserStatus{
		Id:          user.Id,
		Username:    user.Username,
		InboundIds:  user.InboundIds,
		ClientLimit: user.ClientLimit,
		UsedClients: used,
	}, nil
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
		TotalGB:    req.TotalGB,
		ExpiryTime: req.ExpiryTime,
		Enable:     true,
		Group:      groupTag(user.Id),
	}
	payload := &service.ClientCreatePayload{
		Client:     client,
		InboundIds: []int{req.InboundId},
	}
	return (&service.ClientService{}).Create(&service.InboundService{}, payload)
}

// PortalClientView is one tenant-owned client for the /clients list.
type PortalClientView struct {
	Email      string `json:"email"`
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
