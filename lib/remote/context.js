const remoteServers = new WeakSet();
let remoteService = null;

function setRemoteAccessService(service) {
  remoteService = service || null;
}

function getRemoteAccessService() {
  return remoteService;
}

function registerRemoteServer(server) {
  if (server) remoteServers.add(server);
}

function isRemoteRequest(req) {
  return Boolean(req?.socket?.server && remoteServers.has(req.socket.server));
}

module.exports = { setRemoteAccessService, getRemoteAccessService, registerRemoteServer, isRemoteRequest };
