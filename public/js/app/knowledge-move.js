import { initKnowledgeFolderPicker, normalizeRelativeFolder } from './knowledge-folder-picker.js';
export function initKnowledgeMove({ doc = document, getBases, getDocument, move }) {
  const dialog = doc.createElement('dialog');
  dialog.className = 'knowledge-move-dialog';
  dialog.setAttribute('aria-labelledby', 'knowledgeMoveTitle');
  dialog.innerHTML = `<form><div class="knowledge-move-header"><h2 id="knowledgeMoveTitle">移动文档</h2><button type="button" class="icon-button" data-move-close aria-label="关闭移动文档">×</button></div><div class="knowledge-move-body"><p data-move-source></p><label>知识库<select name="base" aria-label="目标知识库"></select></label><label>文件夹<div class="knowledge-folder-input-row"><input name="folder" aria-label="目标文件夹相对路径" aria-describedby="knowledgeFolderHint" placeholder="根目录，或输入相对路径" autocomplete="off"><button type="button" class="secondary-action" data-folder-browse aria-label="选择目标文件夹">选择</button></div></label><p id="knowledgeFolderHint" class="knowledge-folder-hint" data-folder-hint aria-live="polite">相对所选知识库根目录，例如：阅读笔记/小说。留空表示根目录。</p><p data-move-error role="alert" hidden></p></div><div class="knowledge-move-footer"><button type="button" class="secondary-action" data-move-close>取消</button><button class="primary-action" type="submit">移动</button></div></form>`;
  doc.body.append(dialog);
  const form = dialog.querySelector('form'), base = form.elements.namedItem('base'), folder = form.elements.namedItem('folder');
  const submit = form.querySelector('[type="submit"]'), error = form.querySelector('[data-move-error]');
  let current = null, origin = null, pending = false;
  const browse = form.querySelector('[data-folder-browse]'), hint = form.querySelector('[data-folder-hint]');
  const picker = initKnowledgeFolderPicker({ doc, input: folder, trigger: browse, getNodes: () => getBases().find(item => item.name === base.value)?.folders || [], onChange: update });
  function pathExists(path) {
    if (path === '') return true;
    const walk = nodes => nodes.some(node => node.path === path || walk(node.children || []));
    return walk(getBases().find(item => item.name === base.value)?.folders || []);
  }
  const option = (value, name) => { const el = doc.createElement('option'); el.value = value; el.textContent = name; return el; };
  function update() {
    const path = normalizeRelativeFolder(folder.value);
    const invalid = path === null || !pathExists(path);
    hint.textContent = invalid ? (path === null ? '请输入知识库内的相对路径，不能使用绝对路径或 ..。' : '目录不存在，请选择已有文件夹或修改路径。') : '相对所选知识库根目录；留空表示根目录。';
    hint.classList.toggle('is-error', invalid);
    folder.setAttribute('aria-invalid', String(invalid));
    submit.disabled = pending || !base.value || invalid || (base.value === current?.knowledgeBase && path === (current?.folderPath || ''));
    submit.textContent = pending ? '移动中…' : '移动';
    base.disabled = folder.disabled = browse.disabled = pending;
    dialog.querySelectorAll('[data-move-close]').forEach(button => { button.disabled = pending; });
  }
  function folders(selected = '') {
    picker.close(); folder.value = selected;
    update();
  }
  function close() {
    if (pending) return;
    picker.close(); dialog.close();
    if (origin?.isConnected) origin.focus();
    else doc.querySelector('#knowledgeSearch')?.focus();
  }
  base.addEventListener('change', () => folders());
  folder.addEventListener('input', update);
  folder.addEventListener('change', update);
  dialog.querySelectorAll('[data-move-close]').forEach(button => button.addEventListener('click', close));
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (submit.disabled || pending || !current) return;
    picker.close(); pending = true; error.hidden = true; update();
    try {
      await move({ type: 'document', id: current.id }, { knowledgeBase: base.value, folderPath: normalizeRelativeFolder(folder.value) });
      pending = false; close();
    } catch (failure) { error.textContent = failure.message || '移动失败，请重试'; error.hidden = false; }
    finally { pending = false; update(); }
  });
  return {
    open(id, trigger) {
      if (pending) return;
      current = getDocument(id); if (!current) return;
      origin = trigger?.closest('[data-document-open]')?.querySelector('.knowledge-row-more') || trigger;
      error.hidden = true;
      form.querySelector('[data-move-source]').textContent = `当前位置：${[current.knowledgeBase || '其他', current.folderPath].filter(Boolean).join(' / ')} · ${current.title || '未命名文档'}`;
      base.replaceChildren(...getBases().map(item => option(item.name, item.name)));
      base.value = current.knowledgeBase || '其他';
      folders(current.folderPath || '');
      doc.dispatchEvent(new doc.defaultView.CustomEvent('knowledge-menu-open', { detail: dialog }));
      dialog.showModal(); base.focus();
    },
    close,
  };
}
