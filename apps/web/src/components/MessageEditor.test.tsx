import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageEditor } from './MessageEditor.js';

// jsdom has no layout; ProseMirror needs these for selection scrolling.
Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => new DOMRect(),
});

function setup() {
  const onChange = vi.fn();
  const onAttach = vi.fn();
  render(<MessageEditor onChange={onChange} onAttach={onAttach} />);
  const editor = (
    screen.getByRole('textbox', { name: 'Message' }) as HTMLElement & { editor: Editor }
  ).editor;
  act(() => {
    editor.commands.setContent('<p>Hello</p>');
    editor.commands.selectAll();
  });
  return { editor, onChange, onAttach };
}

describe('message formatting toolbar', () => {
  it('applies inline formatting to selected content and supports undo, redo and clearing', () => {
    const { editor, onChange } = setup();
    for (const name of ['Bold', 'Italic', 'Underline'])
      fireEvent.click(screen.getByRole('button', { name }));
    expect(editor.getHTML()).toContain('<strong><em><u>Hello</u></em></strong>');
    expect(onChange.mock.lastCall?.[0]).toBe('Hello');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(editor.getHTML()).not.toContain('<u>');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(editor.getHTML()).toContain('<u>');
    fireEvent.click(screen.getByRole('button', { name: 'Clear formatting' }));
    expect(editor.getHTML()).toBe('<p>Hello</p>');
  });

  it('formats headings, alignment, lists and quotes and opens attachment selection', () => {
    const { editor, onAttach } = setup();
    fireEvent.change(screen.getByLabelText('Text style'), { target: { value: 'h2' } });
    fireEvent.change(screen.getByLabelText('Text alignment'), { target: { value: 'center' } });
    expect(editor.getHTML()).toContain('<h2 style="text-align: center;">Hello</h2>');
    fireEvent.click(screen.getByRole('button', { name: 'Clear formatting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bullet list' }));
    expect(editor.getHTML()).toContain('<ul>');
    fireEvent.click(screen.getByRole('button', { name: 'Numbered list' }));
    expect(editor.getHTML()).toContain('<ol>');
    fireEvent.click(screen.getByRole('button', { name: 'Clear formatting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quote' }));
    expect(editor.getHTML()).toContain('<blockquote>');
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }));
    expect(onAttach).toHaveBeenCalledOnce();
  });
});
