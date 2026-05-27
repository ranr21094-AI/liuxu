import { basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';

const appTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
    fontSize: '14px',
    backgroundColor: 'var(--color-card)',
    color: 'var(--color-text)',
  },
  '.cm-scroller': {
    lineHeight: '1.75',
    overflow: 'auto',
  },
  '.cm-content': {
    minHeight: '100%',
    padding: '14px 4px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--color-card)',
    borderRight: '1px solid var(--color-border)',
    color: 'var(--color-text-secondary)',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'rgba(var(--color-primary-rgb), 0.06)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
});

export { basicSetup, Compartment, EditorState, EditorView, markdown, oneDark, appTheme };
