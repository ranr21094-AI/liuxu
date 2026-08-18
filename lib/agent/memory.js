const crypto = require('crypto');

const L0_RULES = Object.freeze({
  layer: 'L0',
  version: 1,
  rules: [
    'Never write secrets, cookies, tokens, API keys, passwords, or PIDs into memory.',
    'Never present unverified guesses as facts.',
    'All long-term memory writes require user confirmation.',
    'Prefer archive over hard delete.',
    'Cite local knowledge with document and chunk identifiers.',
  ],
});

const SECRET_PATTERN = /(api[_-]?key|password|secret|token|cookie|authorization:\s*bearer)/i;

function createMemoryService(store) {
  function list({ layer } = {}) {
    const items = store.readMemories().items.filter(item => item.status === 'active');
    return layer ? items.filter(item => item.layer === layer) : items;
  }

  function propose({ runId, layer, title, content, evidence, existingId }) {
    if (!Array.isArray(evidence) || !evidence.length) return { error: 'Memory requires evidence' };
    if (SECRET_PATTERN.test(`${title}\n${content}\n${JSON.stringify(evidence)}`)) return { error: 'Memory contains secret material' };
    const data = store.readMemories();
    const proposal = {
      id: crypto.randomUUID(),
      runId,
      layer: layer === 'L3' ? 'L3' : 'L2',
      title: String(title || '').slice(0, 120),
      content: String(content || '').slice(0, 4000),
      evidence,
      existingId: existingId || '',
      status: 'pending',
      createdAt: Date.now(),
    };
    data.proposals.unshift(proposal);
    store.writeMemories(data);
    return { proposal };
  }

  function approve(id) {
    const data = store.readMemories();
    const proposal = data.proposals.find(item => item.id === id);
    if (!proposal || proposal.status !== 'pending') return { error: 'Proposal not found' };
    if (proposal.existingId) {
      data.items = data.items.map(item => item.id === proposal.existingId ? { ...item, status: 'superseded', supersededAt: Date.now() } : item);
    }
    const memory = {
      id: crypto.randomUUID(),
      layer: proposal.layer,
      title: proposal.title,
      content: proposal.content,
      evidence: proposal.evidence,
      version: 1,
      status: 'active',
      sourceProposalId: proposal.id,
      createdAt: Date.now(),
    };
    data.items.unshift(memory);
    proposal.status = 'approved';
    proposal.memoryId = memory.id;
    store.writeMemories(data);
    return { memory };
  }

  function contextBlocks() {
    const items = list();
    return {
      l0: L0_RULES,
      l2: items.filter(item => item.layer === 'L2').slice(0, 20),
      l3: items.filter(item => item.layer === 'L3').slice(0, 20),
    };
  }

  return { list, propose, approve, contextBlocks, L0_RULES };
}

module.exports = { createMemoryService, L0_RULES, SECRET_PATTERN };
