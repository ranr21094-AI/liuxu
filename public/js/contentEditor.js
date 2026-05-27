const CODEMIRROR_MODULE_URL = '/generated/editor/editor.js';

export class ContentEditor {
  constructor(textarea, container) {
    this.textarea = textarea;
    this.container = container;
    this.value = textarea.value || '';
    this.listeners = new Set();
    this.visible = false;
    this.editor = null;
    this.module = null;
    this.themeCompartment = null;
    this.loading = null;
    this.suppressChanges = false;

    this.textarea.addEventListener('input', () => {
      if (this.suppressChanges || this.editor) return;
      this.value = this.textarea.value;
      this.emitChange();
    });

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

  loadDocument(value) {
    this.value = value || '';
    this.suppressChanges = true;
    this.textarea.value = this.value;
    if (this.editor) {
      this.editor.dispatch({
        changes: { from: 0, to: this.editor.state.doc.length, insert: this.value },
        selection: { anchor: 0 },
      });
    }
    this.suppressChanges = false;
  }

  getSelection() {
    if (this.editor) {
      const selection = this.editor.state.selection.main;
      return { start: selection.from, end: selection.to };
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
    if (this.editor) {
      this.editor.dispatch({
        changes: { from: 0, to: this.editor.state.doc.length, insert: value },
        selection: { anchor: selectionStart, head: selectionEnd },
      });
    } else {
      this.setSelection(selectionStart, selectionEnd);
    }
    this.suppressChanges = false;
    this.emitChange();
  }

  insertAtSelection(text) {
    const { start, end } = this.getSelection();
    const nextValue = this.value.substring(0, start) + text + this.value.substring(end);
    const cursor = start + text.length;
    this.applyValue(nextValue, cursor, cursor);
  }

  setSelection(start, end = start) {
    if (this.editor) {
      this.editor.dispatch({ selection: { anchor: start, head: end } });
      this.editor.dispatch({ effects: this.module.EditorView.scrollIntoView(end) });
      return;
    }
    this.textarea.selectionStart = start;
    this.textarea.selectionEnd = end;
  }

  setVisible(visible) {
    this.visible = visible;
    this.updateSurface();
    if (!visible) return;
    this.ensureEditor().then(() => {
      if (this.visible) {
        this.updateSurface();
        this.layout();
      }
    }).catch(err => {
      console.error('CodeMirror initialization failed:', err);
      this.updateSurface();
    });
  }

  focus() {
    if (this.editor) {
      this.editor.focus();
      return;
    }
    this.textarea.focus();
    if (this.visible) {
      this.ensureEditor().then(() => {
        if (this.visible) this.editor.focus();
      }).catch(() => {});
    }
  }

  hasFocus() {
    return this.editor
      ? this.editor.hasFocus
      : document.activeElement === this.textarea;
  }

  usesRichEditor() {
    return Boolean(this.editor);
  }

  hasOpenWidget() {
    return Boolean(this.editor && this.container.querySelector('.cm-panels, .cm-tooltip'));
  }

  layout() {
    if (this.editor) {
      this.editor.requestMeasure();
    }
  }

  syncTheme() {
    if (!this.editor || !this.themeCompartment) return;
    this.editor.dispatch({
      effects: this.themeCompartment.reconfigure(this.themeExtensions()),
    });
  }

  themeExtensions() {
    const extensions = [this.module.appTheme];
    if (document.documentElement.getAttribute('data-theme') === 'dark') {
      extensions.unshift(this.module.oneDark);
    }
    return extensions;
  }

  updateSurface() {
    const showCodeMirror = this.visible && Boolean(this.editor);
    const showTextarea = this.visible && !showCodeMirror;
    this.container.style.display = showCodeMirror ? 'block' : 'none';
    this.textarea.style.display = showTextarea ? 'block' : 'none';
  }

  async ensureEditor() {
    if (this.editor) return this.editor;
    if (this.loading) return this.loading;
    this.loading = import(CODEMIRROR_MODULE_URL).then(module => {
      this.module = module;
      this.themeCompartment = new module.Compartment();
      const state = module.EditorState.create({
        doc: this.value,
        extensions: [
          module.basicSetup,
          module.markdown(),
          module.EditorView.lineWrapping,
          this.themeCompartment.of(this.themeExtensions()),
          module.EditorView.updateListener.of(update => {
            if (!update.docChanged || this.suppressChanges) return;
            this.value = update.state.doc.toString();
            this.suppressChanges = true;
            this.textarea.value = this.value;
            this.suppressChanges = false;
            this.emitChange();
          }),
        ],
      });
      this.editor = new module.EditorView({ state, parent: this.container });
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
