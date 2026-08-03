package controller

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/mhsanaei/3x-ui/v3/internal/web/service/panel"
)

type licenseForm struct {
	Code string `json:"code" form:"code"`
}

type licenseCreateForm struct {
	Type  string `json:"type" form:"type"`
	Count int    `json:"count" form:"count"`
}

type licenseDeleteForm struct {
	Id int `json:"id" form:"id"`
}

// LicenseController handles card-key activation and management.
type LicenseController struct {
	licenseService panel.LicenseService
}

func NewLicenseController(g *gin.RouterGroup) *LicenseController {
	a := &LicenseController{}
	a.initRouter(g)
	return a
}

func (a *LicenseController) initRouter(g *gin.RouterGroup) {
	g = g.Group("/license")
	g.GET("/status", a.status)
	g.POST("/activate", a.activate)
	g.POST("/create", a.create)
	g.GET("/list", a.list)
	g.POST("/delete", a.delete)
}

func (a *LicenseController) status(c *gin.Context) {
	jsonObj(c, a.licenseService.Status(), nil)
}

func (a *LicenseController) activate(c *gin.Context) {
	form := &licenseForm{}
	if err := c.ShouldBind(form); err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	if err := a.licenseService.Activate(form.Code); err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	jsonObj(c, a.licenseService.Status(), nil)
}

func (a *LicenseController) create(c *gin.Context) {
	form := &licenseCreateForm{}
	if err := c.ShouldBind(form); err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	codes, err := a.licenseService.CreateCards(form.Type, form.Count)
	if err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	jsonObj(c, codes, nil)
}

func (a *LicenseController) list(c *gin.Context) {
	cards, err := a.licenseService.ListCards()
	if err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	jsonObj(c, cards, nil)
}

func (a *LicenseController) delete(c *gin.Context) {
	form := &licenseDeleteForm{}
	if err := c.ShouldBind(form); err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	if err := a.licenseService.DeleteCard(form.Id); err != nil {
		pureJsonMsg(c, http.StatusOK, false, err.Error())
		return
	}
	pureJsonMsg(c, http.StatusOK, true, "")
}
