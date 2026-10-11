// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ContentEditor } from './ContentEditor.js';

describe('ContentEditor', () => {
  it('loads Markdown into TipTap and saves a platform-neutral draft', async () => {
    const onSave = vi.fn();
    render(<ContentEditor
      initialValue={{
        itemId: 'item-1',
        kind: 'ARTICLE',
        title: '初稿',
        bodyMarkdown: '**加粗正文**',
      }}
      onCancel={vi.fn()}
      onSave={onSave}
    />);

    expect(await screen.findByText('加粗正文')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '加粗' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('内容标题'), { target: { value: '第二稿' } });
    fireEvent.click(screen.getByRole('button', { name: '保存新修订' }));

    expect(onSave).toHaveBeenCalledWith({
      itemId: 'item-1',
      kind: 'ARTICLE',
      title: '第二稿',
      bodyMarkdown: '**加粗正文**',
    });
  });

  it('does not allow an untitled draft to be saved', () => {
    render(<ContentEditor onCancel={vi.fn()} onSave={vi.fn()} />);

    expect(screen.getByRole('button', { name: '保存新修订' })).toBeDisabled();
  });
});
