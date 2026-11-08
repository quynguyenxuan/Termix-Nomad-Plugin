import React from "react";
import { useTheme } from "@termix-ssh/plugin-sdk/frontend";
import { basicSetup } from "codemirror";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { hcl } from "codemirror-lang-hcl";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Format } from "./nomad-api";

interface Props {
  label: string;
  value: string;
  format: Format;
  wrap: boolean;
  readOnly?: boolean;
  onChange(value: string): void;
}
const externalChange = Annotation.define<boolean>();
const highlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.name, tags.operator, tags.punctuation], color: "var(--foreground)" },
  { tag: [tags.keyword, tags.typeName, tags.string, tags.number, tags.bool, tags.null], color: "light-dark(#92400e, #fbbf24)" },
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: tags.invalid, color: "var(--destructive)" },
]));

const theme = EditorView.theme({
  "&": { fontSize: "0.75rem", color: "var(--foreground)", backgroundColor: "var(--background)" },
  ".cm-scroller": { fontFamily: "ui-monospace, monospace", overflow: "auto", maxHeight: "32rem" },
  ".cm-content": { minHeight: "14rem", padding: "0.75rem 0" },
  ".cm-gutters": { backgroundColor: "var(--muted)", color: "var(--muted-foreground)", borderColor: "var(--border)" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--muted)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--accent)" },
  "&.cm-focused": { outline: "2px solid var(--ring)", outlineOffset: "2px" },
});

export function JobSourceEditor({ label, value, format, wrap, readOnly = false, onChange }: Props) {
  const { theme: colorScheme } = useTheme();
  const container = React.useRef<HTMLDivElement>(null);
  const view = React.useRef<EditorView | null>(null);
  const callback = React.useRef(onChange);
  callback.current = onChange;
  const compartments = React.useMemo(() => ({ language: new Compartment(), wrap: new Compartment(), editable: new Compartment() }), []);
  React.useEffect(() => {
    if (!container.current) return;
    const editor = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          theme,
          highlighting,
          keymap.of([indentWithTab]),
          EditorView.contentAttributes.of({ "aria-label": label, "aria-multiline": "true", spellcheck: "false" }),
          compartments.language.of(format === "json" ? json() : hcl()),
          compartments.wrap.of(wrap ? EditorView.lineWrapping : []),
          compartments.editable.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          EditorView.updateListener.of(update => {
            if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalChange))) callback.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => { view.current = null; editor.destroy(); };
  }, []);
  React.useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      // External imports replace the document; don't echo them as user edits.
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value }, annotations: externalChange.of(true) });
    }
  }, [value]);
  React.useEffect(() => {
    view.current?.dispatch({ effects: [
      compartments.language.reconfigure(format === "json" ? json() : hcl()),
      compartments.wrap.reconfigure(wrap ? EditorView.lineWrapping : []),
      compartments.editable.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    ] });
  }, [format, wrap, readOnly, compartments]);
  return <div className="space-y-1" style={{ colorScheme }}><p className="text-sm">{label}</p><div ref={container} className="min-w-0 overflow-hidden rounded-md border border-input" /><p className="text-xs text-muted-foreground">Tab indents. Press Escape then Tab to move focus out of the editor.</p></div>;
}
