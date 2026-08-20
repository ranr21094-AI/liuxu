const { registerKnowledgeRoutes } = require('../knowledge/routes');
const { registerAgentRoutes } = require('../agent/routes');
const { registerWorkspaceRoutes } = require('../workspace/routes');
const { registerBackupRoutes } = require('./backup-routes');
const { registerComputerRoutes, createComputerFacade } = require('../computer/routes');
const { createChromeBridge } = require('../computer/chrome');

function mountNewApis(app, ctx) {
  registerKnowledgeRoutes(app, ctx);
  registerWorkspaceRoutes(app, ctx);
  registerBackupRoutes(app, ctx);
  registerComputerRoutes(app, ctx);
  registerAgentRoutes(app, {
    ...ctx,
    computerFor: (req) => {
      const mb = ctx.db.getAiSettings?.()?.agentFileReadMaxMb ?? 4;
      return createComputerFacade(req, ctx.db.dataDir, { fileReadMaxBytes: mb * 1024 * 1024 });
    },
    chromeFor: () => createChromeBridge(ctx.db.dataDir),
  });
}

module.exports = { mountNewApis };
