import { escHtml } from '../helpers.js';
export function renderProviderDirectory(providers, kind = 'text') {
  const image = kind === 'image';
  const attribute = image ? 'data-select-image-provider' : 'data-select-provider';
  const add = image ? 'data-image-add="provider"' : 'data-add-provider="directory"';
  return `<div class="provider-directory"><div class="provider-directory-heading"><h4>${image ? '生图供应商' : '自定义供应商'}</h4><button type="button" class="secondary-action compact" ${add}>＋ 添加供应商</button></div><div class="provider-directory-list">${providers.map(provider => {
    const name = provider.name?.trim() || '未命名供应商';
    const protocol = image ? provider.adapter : provider.apiFormat || 'openai';
    const count = image ? (provider.models || []).length : (provider.models || []).filter(model => model.id).length;
    return `<button type="button" class="provider-directory-row" ${attribute}="${escHtml(provider.id)}" title="${escHtml(name)}" aria-label="编辑供应商：${escHtml(name)}"><span class="provider-avatar" aria-hidden="true">${escHtml(Array.from(name)[0].toUpperCase())}</span><span class="provider-directory-name">${escHtml(name)}</span><span class="provider-protocol">${escHtml(protocol)}</span><span class="provider-directory-count">${count} 个模型${provider.enabled === false ? ' · 已禁用' : ''}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"></path></svg></button>`;
  }).join('') || '<p class="empty-list">还没有供应商，添加后开始配置。</p>'}</div></div>`;
}
