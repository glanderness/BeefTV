package handler

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"infinite-canvas/backend/internal/creativebible"
	"infinite-canvas/backend/internal/kernel"
)

type creativeBibleRouteService interface {
	workspaceOwners
	Database() *gorm.DB
}

// RegisterCreativeBibleRoutes exposes project-level (and standalone canvas-level)
// Creative Bible CRUD for the desktop UI so both the Project workbench and Canvas
// share one structured specification with the built-in assistant and external MCP.
func RegisterCreativeBibleRoutes(r gin.IRouter, svc creativeBibleRouteService) {
	handleGet := func(c *gin.Context, scopeKind string) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		db := svc.Database()
		id := strings.TrimSpace(c.Param("id"))
		var resolvedKind, resolvedID string
		if scopeKind == creativebible.ScopeProject {
			if err := creativebible.VerifyProjectOwnership(db, user.ID, id); err != nil {
				failService(c, err)
				return
			}
			resolvedKind, resolvedID = creativebible.ScopeProject, id
		} else {
			resolvedKind, resolvedID, err = creativebible.ResolveScopeForCanvas(db, user.ID, id)
			if err != nil {
				failService(c, err)
				return
			}
		}
		bible, err := creativebible.Get(db, user.ID, resolvedKind, resolvedID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{
			"bible":  bible,
			"digest": creativebible.FormatDigest(bible),
			"empty":  bible.IsEmpty(),
		})
	}

	handlePut := func(c *gin.Context, scopeKind string) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 128<<10)
		var input creativebible.UpdateInput
		if err := c.ShouldBindJSON(&input); err != nil {
			fail(c, http.StatusBadRequest, kernel.BadAuthRequest("创作设定集格式无效"))
			return
		}
		db := svc.Database()
		id := strings.TrimSpace(c.Param("id"))
		var resolvedKind, resolvedID string
		if scopeKind == creativebible.ScopeProject {
			if err := creativebible.VerifyProjectOwnership(db, user.ID, id); err != nil {
				failService(c, err)
				return
			}
			resolvedKind, resolvedID = creativebible.ScopeProject, id
		} else {
			resolvedKind, resolvedID, err = creativebible.ResolveScopeForCanvas(db, user.ID, id)
			if err != nil {
				failService(c, err)
				return
			}
		}
		saved, err := creativebible.Save(db, user.ID, resolvedKind, resolvedID, input)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{
			"bible":  saved,
			"digest": creativebible.FormatDigest(saved),
			"empty":  saved.IsEmpty(),
		})
	}

	r.GET("/projects/:id/creative-bible", func(c *gin.Context) { handleGet(c, creativebible.ScopeProject) })
	r.PUT("/projects/:id/creative-bible", func(c *gin.Context) { handlePut(c, creativebible.ScopeProject) })
	r.GET("/canvas-projects/:id/creative-bible", func(c *gin.Context) { handleGet(c, creativebible.ScopeCanvas) })
	r.PUT("/canvas-projects/:id/creative-bible", func(c *gin.Context) { handlePut(c, creativebible.ScopeCanvas) })
}
