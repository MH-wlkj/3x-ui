package controller

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/mhsanaei/3x-ui/v3/internal/database/model"
	"github.com/mhsanaei/3x-ui/v3/internal/web/service"
	"github.com/mhsanaei/3x-ui/v3/internal/web/service/panel"
	"github.com/mhsanaei/3x-ui/v3/internal/web/service/portal"
)

type portalUserForm struct {
	Id          int    `json:"id" form:"id"`
	Username    string `json:"username" form:"username"`
	Password    string `json:"password" form:"password"`
	InboundIds  []int  `json:"inboundIds" form:"inboundIds"`
	ClientLimit int    `json:"clientLimit" form:"clientLimit"`
	Enable      *bool  `json:"enable" form:"enable"`
}

type portalLoginForm struct {
	Username string `json:"username" form:"username"`
	Password string `json:"password" form:"password"`
}

type portalClientForm struct {
	InboundId  int    `json:"inboundId" form:"inboundId"`
	Email      string `json:"email" form:"email"`
	TotalGB    int64  `json:"totalGB" form:"totalGB"`
	ExpiryTime int64  `json:"expiryTime" form:"expiryTime"`
}

type portalDeleteForm struct {
	Email string `json:"email" form:"email"`
}

type portalPasswordForm struct {
	OldPassword string `json:"oldPassword" form:"oldPassword"`
	NewPassword string `json:"newPassword" form:"newPassword"`
}

// PortalController exposes admin tenant-user management (under /panel/api,
// session/token + CSRF protected) and the token-authenticated user portal API
// (under /portal/api, bearer-token protected).
type PortalController struct {
	BaseController
	portalService  portal.PortalService
	userService    panel.UserService
	clientService  service.ClientService
	inboundService service.InboundService
}

func NewPortalController(g *gin.RouterGroup) *PortalController {
	a := &PortalController{}
	a.initRouter(g)
	return a
}

func NewPortalTokenController(g *gin.RouterGroup) *PortalController {
	a := &PortalController{}
	a.initTokenRouter(g)
	return a
}

// initRouter mounts the admin user-management routes on the authed API group.
func (a *PortalController) initRouter(g *gin.RouterGroup) {
	g = g.Group("/portal")
	g.GET("/users", a.listUsers)
	g.POST("/users/create", a.createUser)
	g.POST("/users/update", a.updateUser)
	g.POST("/users/delete", a.deleteUser)
}

// initTokenRouter mounts the token-authenticated portal routes outside the
// admin API group.
func (a *PortalController) initTokenRouter(g *gin.RouterGroup) {
	g = g.Group("/portal/api")
	g.POST("/login", a.portalLogin)
	g.POST("/logout", a.portalLogout)
	g.GET("/me", a.portalTokenAuth, a.portalStatus)
	g.GET("/inbounds", a.portalTokenAuth, a.portalInbounds)
	g.POST("/clients", a.portalTokenAuth, a.portalCreateClient)
	g.GET("/clients", a.portalTokenAuth, a.portalListClients)
	g.POST("/clients/delete", a.portalTokenAuth, a.portalDeleteClient)
	g.POST("/password", a.portalTokenAuth, a.portalChangePassword)
}

// ---- admin: user management ----

func (a *PortalController) listUsers(c *gin.Context) {
	users, err := a.portalService.ListUsers()
	jsonObj(c, users, err)
}

func (a *PortalController) createUser(c *gin.Context) {
	form := &portalUserForm{}
	if err := c.ShouldBind(form); err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	enable := true
	if form.Enable != nil {
		enable = *form.Enable
	}
	if err := a.portalService.CreateUser(form.Username, form.Password, form.InboundIds, form.ClientLimit, enable); err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	pureJsonMsg(c, http.StatusOK, true, "user created")
}

func (a *PortalController) updateUser(c *gin.Context) {
	form := &portalUserForm{}
	if err := c.ShouldBind(form); err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	if form.Id <= 0 {
		pureJsonMsg(c, http.StatusOK, false, "user id is required")
		return
	}
	enable := true
	if form.Enable != nil {
		enable = *form.Enable
	}
	if err := a.portalService.UpdateUser(form.Id, form.Username, form.Password, form.InboundIds, form.ClientLimit, enable); err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	pureJsonMsg(c, http.StatusOK, true, "user updated")
}

func (a *PortalController) deleteUser(c *gin.Context) {
	form := &portalUserForm{}
	if err := c.ShouldBind(form); err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	if form.Id <= 0 {
		pureJsonMsg(c, http.StatusOK, false, "user id is required")
		return
	}
	if err := a.portalService.DeleteUser(form.Id); err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	pureJsonMsg(c, http.StatusOK, true, "user deleted")
}

// ---- portal auth + operations ----

func (a *PortalController) portalLogin(c *gin.Context) {
	form := &portalLoginForm{}
	if err := c.ShouldBind(form); err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	token, err := a.portalService.Login(form.Username, form.Password)
	if err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	jsonObj(c, gin.H{"token": token}, nil)
}

func (a *PortalController) portalLogout(c *gin.Context) {
	auth := c.GetHeader("Authorization")
	if token, ok := strings.CutPrefix(auth, "Bearer "); ok {
		a.portalService.Logout(token)
	}
	pureJsonMsg(c, http.StatusOK, true, "logged out")
}

func (a *PortalController) portalTokenAuth(c *gin.Context) {
	auth := c.GetHeader("Authorization")
	token, ok := strings.CutPrefix(auth, "Bearer ")
	if !ok {
		c.AbortWithStatusJSON(http.StatusOK, gin.H{"success": false, "msg": "missing portal token"})
		return
	}
	user, err := a.portalService.UserByToken(token)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusOK, gin.H{"success": false, "msg": err.Error()})
		return
	}
	c.Set("portalUser", user)
	c.Next()
}

func (a *PortalController) portalStatus(c *gin.Context) {
	user := a.portalUser(c)
	status, err := a.portalService.UserStatus(user)
	jsonObj(c, status, err)
}

func (a *PortalController) portalInbounds(c *gin.Context) {
	user := a.portalUser(c)
	adminUser, err := a.userService.GetFirstUser()
	if err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	options, err := a.portalService.AllowedInbounds(user, adminUser.Id)
	jsonObj(c, options, err)
}

func (a *PortalController) portalCreateClient(c *gin.Context) {
	user := a.portalUser(c)
	form := &portalClientForm{}
	if err := c.ShouldBind(form); err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	req := &portal.CreateClientRequest{
		InboundId:  form.InboundId,
		Email:      form.Email,
		TotalGB:    form.TotalGB,
		ExpiryTime: form.ExpiryTime,
	}
	needRestart, err := a.portalService.CreateClient(user, req)
	jsonObj(c, gin.H{"needRestart": needRestart}, err)
}

func (a *PortalController) portalListClients(c *gin.Context) {
	user := a.portalUser(c)
	views, err := a.portalService.ListClients(user)
	jsonObj(c, views, err)
}

func (a *PortalController) portalDeleteClient(c *gin.Context) {
	user := a.portalUser(c)
	form := &portalDeleteForm{}
	if err := c.ShouldBind(form); err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	needRestart, err := a.portalService.DeleteClient(user, form.Email)
	jsonObj(c, gin.H{"needRestart": needRestart}, err)
}

func (a *PortalController) portalChangePassword(c *gin.Context) {
	user := a.portalUser(c)
	form := &portalPasswordForm{}
	if err := c.ShouldBind(form); err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	if err := a.portalService.ChangePassword(user, form.OldPassword, form.NewPassword); err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	pureJsonMsg(c, http.StatusOK, true, "password updated")
}

func (a *PortalController) portalUser(c *gin.Context) *model.PanelUser {
	return c.MustGet("portalUser").(*model.PanelUser)
}
