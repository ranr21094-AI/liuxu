const CODE_EXTENSIONS = new Set('js mjs ts tsx jsx css html htm py sh sql json xml yaml yml ini toml c h cpp cc hpp go rs java swift kt kts rb php r lua vue svelte bat ps1 ipynb tex diff patch'.split(' '));
const ICONS = {
  note: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  mindmap: '<rect x="9" y="9" width="6" height="6" rx="1"/><path d="M12 9V4M9 12H4M15 12h5M12 15v5"/>',
  document: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m4 18 5-5 4 3 3-4 5 6"/>',
  audio: '<path d="M10 17V5l9-2v12M10 8l9-2"/><ellipse cx="7" cy="17" rx="3" ry="2"/><ellipse cx="16" cy="15" rx="3" ry="2"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16"/>',
  archive: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M11 3v11h3v4h-4v-4h2M11 6h2M11 9h2"/>',
  file: '<path d="M6 3h8l4 4v14H6zM14 3v5h4"/>',
};
const LABELS = { note: 'Markdown', mindmap: '思维导图', document: '文档', image: '图片', audio: '音频', video: '视频', code: '代码', archive: '压缩包', file: '文件' };
export function documentType(document) {
  let kind = 'file';
  if (document.documentRole === 'mindmap') kind = 'mindmap';
  else if (document.sourceType === 'note' || String(document.id).startsWith('note:')) kind = 'note';
  else {
    const meta = document.fileMeta || {};
    const ext = String(meta.filename || document.title || '').split('.').pop().toLowerCase();
    const preview = meta.previewKind;
    if (ext === 'md') kind = 'note';
    else if (['image', 'audio', 'video'].includes(preview)) kind = preview;
    else if (preview === 'archive') kind = 'archive';
    else if (preview === 'text' && CODE_EXTENSIONS.has(ext)) kind = 'code';
    else if (['pdf', 'docx', 'spreadsheet', 'presentation', 'delimited', 'text'].includes(preview)) kind = 'document';
  }
  return { kind, label: LABELS[kind], icon: `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[kind]}</svg>` };
}
