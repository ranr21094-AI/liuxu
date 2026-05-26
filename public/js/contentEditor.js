const DESKTOP_QUERY = '(min-width: 769px)';
const MONACO_STYLE_ID = 'monacoEditorStyles';
const MONACO_CSS_URL = '/generated/monaco/editor.css';
const MONACO_MODULE_URL = '/generated/monaco/editor.js';

function addMediaListener(mediaQuery, listener) {
  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', listener);
  } else if (typeof mediaQuery.addListener === 'function') {
    mediaQuery.addListener(listener);
  }
}

function ensureMonacoStylesheet() {
  if (document.getElementById(MONACO_STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = MONACO_STYLE_ID;
  link.rel = 'stylesheet';
  link.href = MONACO_CSS_URL;
  document.head.appendChild(link);
}

export class ContentEditor {
  constructor(textarea, container) {
    this.textarea = textarea;
    this.container = container;
    this.value = textarea.value || '';
    this.documentKey = 'draft';
    this.listeners = new Set();
    this.visible = false;
    this.monaco = null;
    this.editor = null;
    this.model = null;
    this.modelSequence = 0;
    this.loading = null;
    this.suppressChanges = false;
    this.desktopQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia(DESKTOP_QUERY)
      : { matches: false, addEventListener() {}, addListener() {} };

    this.textarea.addEventListener('input', () => {
      if (this.suppressChanges) return;
      this.value = this.textarea.value;
      this.syncHiddenMonacoValue();
      this.emitChange();
    });

    addMediaListener(this.desktopQuery, () => {
      if (this.visible && this.desktopQuery.matches) this.ensureMonaco();
      this.updateSurface();
    });

    window.addEventListener('resize', () => this.layout());
    new MutationObserver(() => this.syncTheme()).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }

  onDidChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitChange() {
    this.listeners.forEach(listener => listener(this.value));
  }

  getValue() {
    return this.value;
  }

  loadDocument(value, documentKey = 'draft') {
    this.value = value || '';
    this.documentKey = String(documentKey || 'draft');
    this.suppressChanges = true;
    this.textarea.value = this.value;
    this.suppressChanges = false;
    if (this.editor) this.replaceModel();
  }

  getSelection() {
    if (this.usesMonaco()) {
      const selection = this.editor.getSelection();
      const model = this.editor.getModel();
      if (!selection) return { start: this.value.length, end: this.value.length };
      return {
        start: model.getOffsetAt(selection.getStartPosition()),
        end: model.getOffsetAt(selection.getEndPosition()),
      };
    }
    return {
      start: this.textarea.selectionStart,
      end: this.textarea.selectionEnd,
    };
  }

  applyValue(value, selectionStart, selectionEnd = selectionStart) {
    this.value = value;
    this.suppressChanges = true;
    this.textarea.value = value;
    if (this.usesMonaco()) {
      const model = this.editor.getModel();
      this.editor.pushUndoStop();
      this.editor.executeEdits('work-log', [{
        range: model.getFullModelRange(),
        text: value,
        forceMoveMarkers: true,
      }]);
      this.editor.pushUndoStop();
      this.setSelection(selectionStart, selectionEnd);
    } else if (this.editor) {
      this.editor.getModel().setValue(value);
    }
    this.suppressChanges = false;
    if (!this.usesMonaco()) this.setSelection(selectionStart, selectionEnd);
    this.emitChange();
  }

  insertAtSelection(text) {
    const { start, end } = this.getSelection();
    const nextValue = this.value.substring(0, start) + text + this.value.substring(end);
    const cursor = start + text.length;
    this.applyValue(nextValue, cursor, cursor);
  }

  setSelection(start, end = start) {
    if (this.usesMonaco()) {
      const model = this.editor.getModel();
      const startPosition = model.getPositionAt(start);
      const endPosition = model.getPositionAt(end);
      this.editor.setSelection({
        startLineNumber: startPosition.lineNumber,
        startColumn: startPosition.column,
        endLineNumber: endPosition.lineNumber,
        endColumn: endPosition.column,
      });
      this.editor.revealPositionInCenterIfOutsideViewport(endPosition);
      return;
    }
    this.textarea.selectionStart = start;
    this.textarea.selectionEnd = end;
  }

  setVisible(visible) {
    this.visible = visible;
    this.updateSurface();
    if (visible && this.desktopQuery.matches) {
      this.ensureMonaco().then(() => {
        if (this.visible && this.desktopQuery.matches) {
          this.updateSurface();
          this.layout();
        }
      }).catch(err => {
        console.error('Monaco initialization failed:', err);
        this.updateSurface();
      });
    }
  }

  focus() {
    if (this.usesMonaco()) {
      this.editor.focus();
      return;
    }
    this.textarea.focus();
    if (this.visible && this.desktopQuery.matches) {
      this.ensureMonaco().then(() => {
        if (this.visible && this.desktopQuery.matches) this.editor.focus();
      }).catch(() => {});
    }
  }

  hasFocus() {
    return this.usesMonaco()
      ? this.editor.hasTextFocus()
      : document.activeElement === this.textarea;
  }

  usesMonaco() {
    return Boolean(this.editor && this.desktopQuery.matches);
  }

  hasOpenWidget() {
    if (!this.usesMonaco()) return false;
    return Boolean(this.container.querySelector(
      '.find-widget.visible, .suggest-widget.visible, .parameter-hints-widget.visible, .monaco-hover:not(.hidden)',
    ));
  }

  layout() {
    if (this.usesMonaco() && this.visible) this.editor.layout();
  }

  syncTheme() {
    if (!this.monaco) return;
    const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'vs-dark' : 'vs';
    this.monaco.editor.setTheme(theme);
  }

  updateSurface() {
    const showMonaco = this.visible && this.usesMonaco();
    const showTextarea = this.visible && !showMonaco;
    this.container.style.display = showMonaco ? 'block' : 'none';
    this.textarea.style.display = showTextarea ? 'block' : 'none';
    if (showMonaco) this.layout();
  }

  syncHiddenMonacoValue() {
    if (!this.editor || this.usesMonaco()) return;
    this.suppressChanges = true;
    this.editor.getModel().setValue(this.value);
    this.suppressChanges = false;
  }

  replaceModel() {
    const priorModel = this.model;
    const path = encodeURIComponent(this.documentKey);
    const uri = this.monaco.Uri.parse(`inmemory://work-log/${path}-${++this.modelSequence}.md`);
    this.model = this.monaco.editor.createModel(this.value, 'markdown', uri);
    if (this.editor) this.editor.setModel(this.model);
    if (priorModel) priorModel.dispose();
  }

  async ensureMonaco() {
    if (this.editor) return this.editor;
    if (this.loading) return this.loading;
    ensureMonacoStylesheet();
    this.loading = import(MONACO_MODULE_URL).then(module => {
      module.configureWorkers();
      this.monaco = module.monaco;
      this.replaceModel();
      this.editor = this.monaco.editor.create(this.container, {
        model: this.model,
        theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'vs-dark' : 'vs',
        lineNumbers: 'on',
        minimap: { enabled: true },
        wordWrap: 'on',
        automaticLayout: false,
        scrollBeyondLastLine: false,
        fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
        fontSize: 14,
        lineHeight: 25,
        padding: { top: 14, bottom: 14 },
      });
      this.editor.onDidChangeModelContent(() => {
        if (this.suppressChanges) return;
        this.value = this.editor.getValue();
        this.suppressChanges = true;
        this.textarea.value = this.value;
        this.suppressChanges = false;
        this.emitChange();
      });
      return this.editor;
    }).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }
}

export function createContentEditor(textarea, container) {
  return new ContentEditor(textarea, container);
}
