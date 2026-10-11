import { Markdown } from '@tiptap/markdown';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  Bold,
  Code2,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Save,
  Undo2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import type { CreateContentRequest } from '../../shared/ipc.js';

export interface EditorValue extends CreateContentRequest {
  itemId?: string;
}

export interface ContentEditorProps {
  initialValue?: EditorValue;
  saving?: boolean;
  onSave(value: EditorValue): void | Promise<void>;
  onCancel(): void;
}

export function ContentEditor({
  initialValue,
  saving = false,
  onSave,
  onCancel,
}: ContentEditorProps): React.JSX.Element {
  const [title, setTitle] = useState(initialValue?.title ?? '');
  const [kind, setKind] = useState<CreateContentRequest['kind']>(initialValue?.kind ?? 'ARTICLE');
  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: initialValue?.bodyMarkdown ?? '',
    contentType: 'markdown',
    immediatelyRender: false,
    editorProps: {
      attributes: {
        'aria-label': '正文',
        class: 'content-editor-surface',
      },
    },
  });

  useEffect(() => {
    setTitle(initialValue?.title ?? '');
    setKind(initialValue?.kind ?? 'ARTICLE');
    editor?.commands.setContent(initialValue?.bodyMarkdown ?? '', { contentType: 'markdown' });
  }, [editor, initialValue]);

  const handleSave = (): void => {
    if (editor === null || title.trim().length === 0) {
      return;
    }

    const itemId = initialValue?.itemId;
    void onSave({
      ...(itemId === undefined ? {} : { itemId }),
      kind,
      title: title.trim(),
      bodyMarkdown: editor.getMarkdown(),
    });
  };

  return (
    <section className="editor-shell" aria-label="内容编辑器">
      <header className="editor-header">
        <div>
          <p className="eyebrow">IMMUTABLE REVISION</p>
          <h1>{initialValue?.itemId === undefined ? '创建内容' : '编辑新修订'}</h1>
          <p>保存会创建不可变修订；已批准的发布任务会自动回到待审核。</p>
        </div>
        <div className="editor-actions">
          <button className="secondary-action" type="button" onClick={onCancel}>
            <X size={17} />取消
          </button>
          <button
            className="primary-action"
            type="button"
            disabled={saving || title.trim().length === 0 || editor === null}
            onClick={handleSave}
          >
            <Save size={17} />{saving ? '保存中…' : '保存新修订'}
          </button>
        </div>
      </header>

      <div className="editor-fields">
        <label>
          <span>内容标题</span>
          <input
            aria-label="内容标题"
            maxLength={200}
            placeholder="输入一个清晰的标题"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          <span>内容类型</span>
          <select
            aria-label="内容类型"
            value={kind}
            onChange={(event) => setKind(event.target.value as CreateContentRequest['kind'])}
          >
            <option value="ARTICLE">文章</option>
            <option value="IMAGE_POST">图文</option>
            <option value="VIDEO">视频</option>
          </select>
        </label>
      </div>

      <div className="editor-card">
        <div className="editor-toolbar" role="toolbar" aria-label="正文格式">
          <ToolbarButton label="加粗" active={editor?.isActive('bold') ?? false} onClick={() => editor?.chain().focus().toggleBold().run()}><Bold /></ToolbarButton>
          <ToolbarButton label="斜体" active={editor?.isActive('italic') ?? false} onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic /></ToolbarButton>
          <ToolbarButton label="二级标题" active={editor?.isActive('heading', { level: 2 }) ?? false} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 /></ToolbarButton>
          <ToolbarButton label="无序列表" active={editor?.isActive('bulletList') ?? false} onClick={() => editor?.chain().focus().toggleBulletList().run()}><List /></ToolbarButton>
          <ToolbarButton label="有序列表" active={editor?.isActive('orderedList') ?? false} onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered /></ToolbarButton>
          <ToolbarButton label="引用" active={editor?.isActive('blockquote') ?? false} onClick={() => editor?.chain().focus().toggleBlockquote().run()}><Quote /></ToolbarButton>
          <ToolbarButton label="代码块" active={editor?.isActive('codeBlock') ?? false} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}><Code2 /></ToolbarButton>
          <span className="toolbar-spacer" />
          <ToolbarButton label="撤销" onClick={() => editor?.chain().focus().undo().run()}><Undo2 /></ToolbarButton>
          <ToolbarButton label="重做" onClick={() => editor?.chain().focus().redo().run()}><Redo2 /></ToolbarButton>
        </div>
        <EditorContent editor={editor} />
        <footer className="editor-status">
          <span>Markdown 双向保真</span>
          <span>{editor?.storage.characterCount?.characters?.() ?? editor?.getText().length ?? 0} 字</span>
        </footer>
      </div>
    </section>
  );
}

interface ToolbarButtonProps {
  label: string;
  active?: boolean;
  onClick(): void;
  children: React.ReactNode;
}

function ToolbarButton({ label, active = false, onClick, children }: ToolbarButtonProps): React.JSX.Element {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={active ? 'toolbar-button active' : 'toolbar-button'}
      title={label}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
