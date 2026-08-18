import { apiFetch } from './auth.js';
import { showToast, escHtml, cssNumber, confirmDialog, $ } from './helpers.js';

const PHOTO_WALL_ENDPOINT = '/api/photo-wall';
const VIEWPORT_STORAGE_KEY = 'photoWallViewport';
const COMMENT_SAVE_DELAY = 500;
const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
const DEFAULT_ITEM_WIDTH = 320;
const DEFAULT_ITEM_HEIGHT = 240;

let items = [];
let selectedId = null;
let viewport = loadViewport();
let loaded = false;
let dragState = null;
let commentTimers = new Map();

function loadViewport() {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEWPORT_STORAGE_KEY) || '{}');
    return {
      x: Number.isFinite(saved.x) ? saved.x : 120,
      y: Number.isFinite(saved.y) ? saved.y : 90,
      scale: Number.isFinite(saved.scale) ? clampScale(saved.scale) : 1,
    };
  } catch {
    return { x: 120, y: 90, scale: 1 };
  }
}

function saveViewport() {
  localStorage.setItem(VIEWPORT_STORAGE_KEY, JSON.stringify(viewport));
}

function clampScale(scale) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

function selectedItem() {
  return items.find(item => item.id === selectedId) || null;
}

function updateSidebarState() {
  const count = $('#photoWallCount');
  if (count) count.textContent = String(items.length);
  const deleteButton = $('#btnPhotoWallDelete');
  if (deleteButton) deleteButton.disabled = !selectedItem();
  const zoom = $('#photoWallZoomLabel');
  if (zoom) zoom.textContent = `${Math.round(viewport.scale * 100)}%`;
}

function applyViewport() {
  const stage = $('#photoWallStage');
  if (!stage) return;
  stage.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`;
  updateSidebarState();
  saveViewport();
}

function renderPhotoWall() {
  const stage = $('#photoWallStage');
  const empty = $('#photoWallEmpty');
  if (!stage) return;
  empty.style.display = items.length ? 'none' : 'grid';
  stage.innerHTML = items
    .slice()
    .sort((a, b) => a.z - b.z || a.id - b.id)
    .map(item => `
      <article class="photo-wall-item ${item.id === selectedId ? 'selected' : ''}" data-id="${item.id}" style="left:${cssNumber(item.x)}px;top:${cssNumber(item.y)}px;width:${cssNumber(item.width, DEFAULT_ITEM_WIDTH)}px;z-index:${cssNumber(item.z)};">
        <div class="photo-wall-image-frame">
          <img src="${escHtml(item.url)}" alt="${escHtml(item.comment || '照片墙图片')}" draggable="false">
          <button class="photo-wall-resize-handle" type="button" data-action="resize-photo" aria-label="缩放图片"></button>
        </div>
        <label class="sr-only" for="photoWallComment${item.id}">图片评论</label>
        <textarea id="photoWallComment${item.id}" class="photo-wall-comment" data-action="edit-comment" rows="2" maxlength="1000" placeholder="添加评论...">${escHtml(item.comment || '')}</textarea>
      </article>
    `).join('');
  applyViewport();
}

async function loadPhotoWall() {
  const res = await apiFetch(PHOTO_WALL_ENDPOINT);
  if (!res.ok) throw new Error('照片墙加载失败');
  const data = await res.json();
  items = Array.isArray(data.items) ? data.items : [];
  if (selectedId && !items.some(item => item.id === selectedId)) selectedId = null;
  renderPhotoWall();
}

function setMainView() {
  for (const id of ['listView', 'editorView', 'categoryView', 'todoView', 'aiChatView', 'aiSettingsView', 'photoWallView']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.style.display = id === 'photoWallView' ? 'flex' : 'none';
  }
}

export async function showPhotoWallView() {
  setMainView();
  applyViewport();
  if (!loaded) {
    loaded = true;
    try {
      await loadPhotoWall();
    } catch (err) {
      showToast(err.message, 'error');
    }
  } else {
    renderPhotoWall();
  }
}

function screenToWorld(clientX, clientY) {
  const rect = $('#photoWallCanvasShell').getBoundingClientRect();
  return {
    x: (clientX - rect.left - viewport.x) / viewport.scale,
    y: (clientY - rect.top - viewport.y) / viewport.scale,
  };
}

function viewportCenterWorld() {
  const shell = $('#photoWallCanvasShell');
  const rect = shell.getBoundingClientRect();
  return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function itemPatch(item) {
  return {
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    comment: item.comment || '',
    z: item.z || 0,
  };
}

async function saveItem(item, { quiet = true } = {}) {
  const res = await apiFetch(`/api/photo-wall/items/${item.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(itemPatch(item)),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '照片保存失败');
  }
  const saved = await res.json();
  const index = items.findIndex(entry => entry.id === saved.id);
  if (index !== -1) items[index] = saved;
  if (!quiet) showToast('照片墙已保存', 'success');
  return saved;
}

async function bringItemToFront(item) {
  const maxZ = items.reduce((max, entry) => Math.max(max, entry.z || 0), 0);
  if ((item.z || 0) >= maxZ) return;
  item.z = maxZ + 1;
  try {
    await saveItem(item);
  } catch (err) {
    showToast(err.message, 'error');
  }
  renderPhotoWall();
}

function beginDrag(event, itemEl, mode) {
  const item = items.find(entry => entry.id === Number(itemEl.dataset.id));
  if (!item) return;
  selectedId = item.id;
  document.querySelectorAll('.photo-wall-item').forEach(el => {
    el.classList.toggle('selected', el === itemEl);
  });
  updateSidebarState();
  const point = screenToWorld(event.clientX, event.clientY);
  dragState = {
    mode,
    pointerId: event.pointerId,
    id: item.id,
    start: point,
    item: { ...item },
    ratio: item.height / item.width,
  };
  itemEl.setPointerCapture?.(event.pointerId);
  if (mode === 'move') {
    const maxZ = items.reduce((max, entry) => Math.max(max, entry.z || 0), 0);
    if ((item.z || 0) < maxZ) {
      item.z = maxZ + 1;
      itemEl.style.zIndex = item.z;
      void saveItem(item).catch(err => showToast(err.message, 'error'));
    }
  }
}

function updateDraggedItem(event) {
  if (!dragState) return;
  const point = screenToWorld(event.clientX, event.clientY);
  if (dragState.mode === 'pan') {
    viewport.x = dragState.item.x + (event.clientX - dragState.start.x);
    viewport.y = dragState.item.y + (event.clientY - dragState.start.y);
    applyViewport();
    return;
  }
  const item = items.find(entry => entry.id === dragState.id);
  if (!item) return;
  const dx = point.x - dragState.start.x;
  const dy = point.y - dragState.start.y;
  if (dragState.mode === 'resize') {
    item.width = Math.max(40, Math.round((dragState.item.width + dx) * 100) / 100);
    item.height = Math.max(40, Math.round(item.width * dragState.ratio * 100) / 100);
  } else {
    item.x = Math.round((dragState.item.x + dx) * 100) / 100;
    item.y = Math.round((dragState.item.y + dy) * 100) / 100;
  }
  const itemEl = $(`.photo-wall-item[data-id="${item.id}"]`);
  if (itemEl) {
    itemEl.style.left = `${item.x}px`;
    itemEl.style.top = `${item.y}px`;
    itemEl.style.width = `${item.width}px`;
  }
}

async function finishDrag() {
  if (!dragState) return;
  const state = dragState;
  dragState = null;
  if (state.mode === 'pan') {
    saveViewport();
    return;
  }
  const item = items.find(entry => entry.id === state.id);
  if (!item) return;
  try {
    await saveItem(item);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function zoomAt(clientX, clientY, nextScale) {
  const rect = $('#photoWallCanvasShell').getBoundingClientRect();
  const before = screenToWorld(clientX, clientY);
  viewport.scale = clampScale(nextScale);
  viewport.x = clientX - rect.left - before.x * viewport.scale;
  viewport.y = clientY - rect.top - before.y * viewport.scale;
  applyViewport();
}

function zoomBy(factor) {
  const shell = $('#photoWallCanvasShell');
  const rect = shell.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, viewport.scale * factor);
}

function resetView() {
  viewport = { x: 120, y: 90, scale: 1 };
  applyViewport();
}

function fitToItems() {
  const shell = $('#photoWallCanvasShell');
  if (!items.length || !shell) return resetView();
  const rect = shell.getBoundingClientRect();
  const minX = Math.min(...items.map(item => item.x));
  const minY = Math.min(...items.map(item => item.y));
  const maxX = Math.max(...items.map(item => item.x + item.width));
  const maxY = Math.max(...items.map(item => item.y + item.height + 72));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  viewport.scale = clampScale(Math.min(rect.width / (width + 120), rect.height / (height + 120)));
  viewport.x = (rect.width - width * viewport.scale) / 2 - minX * viewport.scale;
  viewport.y = (rect.height - height * viewport.scale) / 2 - minY * viewport.scale;
  applyViewport();
}

async function createItemFromUpload(file) {
  const status = $('#photoWallUploadStatus');
  if (status) status.textContent = `上传中：${file.name}`;
  const form = new FormData();
  form.append('image', file);
  const uploadRes = await apiFetch('/api/upload', { method: 'POST', body: form });
  if (!uploadRes.ok) {
    const err = await uploadRes.json().catch(() => ({}));
    throw new Error(err.error || '图片上传失败');
  }
  const uploaded = await uploadRes.json();
  const center = viewportCenterWorld();
  const item = {
    url: uploaded.url,
    filename: uploaded.filename,
    x: Math.round(center.x - DEFAULT_ITEM_WIDTH / 2),
    y: Math.round(center.y - DEFAULT_ITEM_HEIGHT / 2),
    width: DEFAULT_ITEM_WIDTH,
    height: DEFAULT_ITEM_HEIGHT,
    z: items.length,
  };
  const createRes = await apiFetch('/api/photo-wall/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
  if (!createRes.ok) {
    const err = await createRes.json().catch(() => ({}));
    throw new Error(err.error || '照片墙节点创建失败');
  }
  const saved = await createRes.json();
  items.push(saved);
  selectedId = saved.id;
  renderPhotoWall();
}

async function uploadFiles(files) {
  const list = [...files].filter(file => file.type.startsWith('image/'));
  if (!list.length) return;
  try {
    for (const file of list) await createItemFromUpload(file);
    $('#photoWallUploadStatus').textContent = '';
    showToast('图片已加入照片墙', 'success');
  } catch (err) {
    showToast(err.message, 'error');
    $('#photoWallUploadStatus').textContent = err.message;
  } finally {
    $('#photoWallFileInput').value = '';
  }
}

function scheduleCommentSave(item) {
  clearTimeout(commentTimers.get(item.id));
  commentTimers.set(item.id, setTimeout(async () => {
    try {
      await saveItem(item);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, COMMENT_SAVE_DELAY));
}

async function deleteSelectedItem() {
  const item = selectedItem();
  if (!item) return;
  const confirmed = await confirmDialog({
    title: '删除照片',
    message: '只会从照片墙移除这张图片，不会删除上传文件。',
    confirmText: '删除',
  });
  if (!confirmed) return;
  const res = await apiFetch(`/api/photo-wall/items/${item.id}`, { method: 'DELETE' });
  if (!res.ok) {
    showToast('删除失败', 'error');
    return;
  }
  items = items.filter(entry => entry.id !== item.id);
  selectedId = null;
  renderPhotoWall();
  showToast('已从照片墙移除', 'success');
}

function bindPhotoWallEvents() {
  $('#btnPhotoWallUpload')?.addEventListener('click', () => $('#photoWallFileInput').click());
  $('#photoWallFileInput')?.addEventListener('change', event => uploadFiles(event.target.files));
  $('#btnPhotoWallZoomOut')?.addEventListener('click', () => zoomBy(0.85));
  $('#btnPhotoWallZoomIn')?.addEventListener('click', () => zoomBy(1.18));
  $('#btnPhotoWallReset')?.addEventListener('click', resetView);
  $('#btnPhotoWallFit')?.addEventListener('click', fitToItems);
  $('#btnPhotoWallDelete')?.addEventListener('click', deleteSelectedItem);

  $('#photoWallCanvasShell')?.addEventListener('wheel', event => {
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, viewport.scale * (event.deltaY > 0 ? 0.92 : 1.08));
  }, { passive: false });

  $('#photoWallCanvasShell')?.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const resizeHandle = event.target.closest('[data-action="resize-photo"]');
    const itemEl = event.target.closest('.photo-wall-item');
    if (resizeHandle && itemEl) {
      event.preventDefault();
      return beginDrag(event, itemEl, 'resize');
    }
    if (itemEl) {
      if (event.target.closest('textarea')) return;
      event.preventDefault();
      return beginDrag(event, itemEl, 'move');
    }
    selectedId = null;
    renderPhotoWall();
    dragState = {
      mode: 'pan',
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      item: { x: viewport.x, y: viewport.y },
    };
    $('#photoWallCanvasShell').setPointerCapture?.(event.pointerId);
  });

  $('#photoWallCanvasShell')?.addEventListener('pointermove', updateDraggedItem);
  $('#photoWallCanvasShell')?.addEventListener('pointerup', finishDrag);
  $('#photoWallCanvasShell')?.addEventListener('pointercancel', finishDrag);

  $('#photoWallStage')?.addEventListener('input', event => {
    const input = event.target.closest('[data-action="edit-comment"]');
    if (!input) return;
    const item = items.find(entry => entry.id === Number(input.closest('.photo-wall-item')?.dataset.id));
    if (!item) return;
    item.comment = input.value;
    scheduleCommentSave(item);
  });

  $('#photoWallStage')?.addEventListener('focusout', async event => {
    const input = event.target.closest('[data-action="edit-comment"]');
    if (!input) return;
    const item = items.find(entry => entry.id === Number(input.closest('.photo-wall-item')?.dataset.id));
    if (!item) return;
    clearTimeout(commentTimers.get(item.id));
    try {
      await saveItem(item);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

bindPhotoWallEvents();
