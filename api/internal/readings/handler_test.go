package readings

import (
	"testing"

	"github.com/adam-ctrlc/vital/api/internal/alerts"
	"github.com/adam-ctrlc/vital/api/internal/device"
	"github.com/adam-ctrlc/vital/api/internal/settings"
)

// TestDependenciesFit fails to compile if the real services stop satisfying the
// interfaces app.Routes passes them through.
func TestDependenciesFit(t *testing.T) {
	var (
		_ AlertEvaluator = (*alerts.Service)(nil)
		_ RelayCommands  = (*device.Store)(nil)
		_ SettingsLoader = (*settings.Store)(nil)
	)
}
