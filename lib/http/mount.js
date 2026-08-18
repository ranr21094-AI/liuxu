const { registerKnowledgeRoutes } = require('../knowledge/routes');
const { registerAgentRoutes } = require('../agent/routes');
const { registerWorkspaceRoutes } = require('../workspace/routes');
const { registerComputerRoutes, createComputerFacade } = require('../computer/routes');
const { createChromeBridge } = require('../computer/chrome');

function mountNewApis(app, ctx) {
  registerKnowledgeRoutes(app, ctx);
  registerWorkspaceRoutes(app, ctx);
  registerComputerRoutes(app, ctx);
  registerAgentRoutes(app, {
    ...ctx,
    computerFor: (req) => createComputerFacade(req, ctx.db.dataDir),
    chromeFor: () => createChromeBridge(ctx.db.dataDir),
  });
}

module.exports = { mountNewApis };
