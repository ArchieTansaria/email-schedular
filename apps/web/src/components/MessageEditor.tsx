import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';

export function MessageEditor({
  onChange,
  onAttach,
}: {
  onChange: (text: string, html: string) => void;
  onAttach: () => void;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] }, link: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
    ],
    content: '',
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        class: 'message-editor rich-content',
        role: 'textbox',
        'aria-label': 'Message',
        'aria-multiline': 'true',
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getText({ blockSeparator: '\n' }), editor.getHTML()),
  });

  if (!editor) return <p>Loading editor…</p>;
  const controls = [
    {
      label: 'Undo',
      text: '↶',
      run: () => editor.chain().focus().undo().run(),
      disabled: !editor.can().undo(),
    },
    {
      label: 'Redo',
      text: '↷',
      run: () => editor.chain().focus().redo().run(),
      disabled: !editor.can().redo(),
    },
    {
      label: 'Bold',
      text: 'B',
      run: () => editor.chain().focus().toggleBold().run(),
      active: editor.isActive('bold'),
    },
    {
      label: 'Italic',
      text: 'I',
      run: () => editor.chain().focus().toggleItalic().run(),
      active: editor.isActive('italic'),
    },
    {
      label: 'Underline',
      text: 'U',
      run: () => editor.chain().focus().toggleUnderline().run(),
      active: editor.isActive('underline'),
    },
    {
      label: 'Bullet list',
      text: '• ≡',
      run: () => editor.chain().focus().toggleBulletList().run(),
      active: editor.isActive('bulletList'),
    },
    {
      label: 'Numbered list',
      text: '1. ≡',
      run: () => editor.chain().focus().toggleOrderedList().run(),
      active: editor.isActive('orderedList'),
    },
    {
      label: 'Quote',
      text: '❝',
      run: () => editor.chain().focus().toggleBlockquote().run(),
      active: editor.isActive('blockquote'),
    },
    {
      label: 'Clear formatting',
      text: 'Tx',
      run: () => editor.chain().focus().unsetAllMarks().clearNodes().unsetTextAlign().run(),
    },
  ];

  return (
    <section className="editor-shell">
      <div className="editor-toolbar" role="toolbar" aria-label="Message formatting">
        <select
          aria-label="Text style"
          value={
            editor.isActive('heading', { level: 2 })
              ? 'h2'
              : editor.isActive('heading', { level: 3 })
                ? 'h3'
                : 'p'
          }
          onChange={(event) =>
            event.target.value === 'p'
              ? editor.chain().focus().setParagraph().run()
              : editor
                  .chain()
                  .focus()
                  .setHeading({ level: event.target.value === 'h2' ? 2 : 3 })
                  .run()
          }
        >
          <option value="p">Normal</option>
          <option value="h2">Heading</option>
          <option value="h3">Subheading</option>
        </select>
        {controls.map((control) => (
          <button
            key={control.label}
            type="button"
            title={control.label}
            aria-label={control.label}
            aria-pressed={control.active}
            disabled={control.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={control.run}
          >
            {control.text}
          </button>
        ))}
        <select
          aria-label="Text alignment"
          value={
            editor.getAttributes('paragraph').textAlign ??
            editor.getAttributes('heading').textAlign ??
            'left'
          }
          onChange={(event) => editor.chain().focus().setTextAlign(event.target.value).run()}
        >
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
          <option value="justify">Justify</option>
        </select>
        <button type="button" title="Attach files" aria-label="Attach files" onClick={onAttach}>
          📎
        </button>
      </div>
      <EditorContent editor={editor} />
    </section>
  );
}
