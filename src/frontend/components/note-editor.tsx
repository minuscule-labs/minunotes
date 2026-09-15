import { type EditorCommentAnchor, MarkdownEditor, type MarkdownEditorHandle } from '@dpklabs/minueditor';
import {
  Heading1,
  Heading2,
  Heading3,
  Image,
  List,
  ListChecks,
  ListOrdered,
  MoreHorizontal,
  Plus,
  Quote,
  Redo2,
  Table2,
  Type,
  Undo2,
  X,
} from 'lucide-react';
import { type ComponentProps, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { editorCodeHighlighter } from '../lib/code-highlighter';
import { editorCodeLanguages } from '../lib/editor-languages';
import { minuNotesResourceUrlResolver } from '../lib/resource-urls';
import { getMermaidTheme, useNoteTheme } from '../lib/themes';

type EditorViewLike = Parameters<NonNullable<ComponentProps<typeof MarkdownEditor>['onViewReady']>>[0];

const DEFAULT_TABLE_INSERTION = { columns: 2, bodyRows: 1 } as const;

type WikiLinksProp = ComponentProps<typeof MarkdownEditor>['wikiLinks'];
type CommentsProp = ComponentProps<typeof MarkdownEditor>['comments'];

export function NoteEditor({
  title,
  content,
  saveState,
  onTitleChange,
  onContentChange,
  onImageUpload,
  initialEditing = false,
  editorMode = 'live',
  actions,
  staleNotice,
  updatedMeta,
  headerExtra,
  wikiLinks,
  comments,
  reviewPanel,
  reviewFocus,
  onCommentAnchorPosition,
  readOnly = false,
}: {
  title: string;
  content: string;
  saveState?: 'saved' | 'saving' | 'unsaved' | 'error';
  onTitleChange: (value: string) => void;
  onContentChange: (value: string) => void;
  onImageUpload?: (file: File) => Promise<string> | string;
  initialEditing?: boolean;
  editorMode?: 'live' | 'source';
  actions: ReactNode;
  staleNotice?: ReactNode;
  updatedMeta?: ReactNode;
  headerExtra?: ReactNode;
  wikiLinks?: WikiLinksProp;
  comments?: CommentsProp;
  reviewPanel?: ReactNode;
  reviewFocus?: { from: number; to: number; detached?: boolean; requestId: number } | null;
  onCommentAnchorPosition?: (position: { top: number; left: number; placement: 'above' | 'below' }) => void;
  readOnly?: boolean;
}) {
  const [uploadingImage, setUploadingImage] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [blockMenuOpen, setBlockMenuOpen] = useState(false);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const [imageTab, setImageTab] = useState<'upload' | 'link'>('upload');
  const [imageUrl, setImageUrl] = useState('');
  const [imageAlt, setImageAlt] = useState('');
  const [imagePickerError, setImagePickerError] = useState<string | null>(null);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const editorViewRef = useRef<EditorViewLike | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const editorKeydownCleanupRef = useRef<(() => void) | null>(null);
  const toolbarSurfaceRef = useRef<HTMLDivElement | null>(null);
  const noteTheme = useNoteTheme();
  const mermaid = useMemo(() => ({ theme: getMermaidTheme(noteTheme) }), [noteTheme]);
  const titleValue = title === 'Untitled note' || title === 'Untitled template' ? '' : title;

  useEffect(() => () => editorKeydownCleanupRef.current?.(), []);

  useEffect(() => {
    if (!blockMenuOpen && !historyMenuOpen) return;

    const dismissMenus = (event: PointerEvent) => {
      if (event.target instanceof Node && toolbarSurfaceRef.current?.contains(event.target)) return;
      setBlockMenuOpen(false);
      setHistoryMenuOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setBlockMenuOpen(false);
      setHistoryMenuOpen(false);
    };

    document.addEventListener('pointerdown', dismissMenus, true);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissMenus, true);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [blockMenuOpen, historyMenuOpen]);

  useEffect(() => {
    if (!reviewFocus || reviewFocus.detached) return;
    editorRef.current?.setSelection(reviewFocus.from, reviewFocus.to);
  }, [reviewFocus]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const updateKeyboardOffset = () => {
      const offset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      setKeyboardOffset(offset);
    };

    updateKeyboardOffset();
    viewport.addEventListener('resize', updateKeyboardOffset);
    viewport.addEventListener('scroll', updateKeyboardOffset);
    return () => {
      viewport.removeEventListener('resize', updateKeyboardOffset);
      viewport.removeEventListener('scroll', updateKeyboardOffset);
    };
  }, []);

  const positionCommentDialog = (anchor: EditorCommentAnchor, preferGutter = anchor.anchorType === 'line') => {
    const view = editorViewRef.current;
    if (!view || !onCommentAnchorPosition) return;
    const docLength = view.state.doc.length;
    const from = Math.max(0, Math.min(anchor.from, docLength));
    const to = Math.max(from, Math.min(anchor.to, docLength));
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);
    const anchorTop = Math.min(start?.top ?? end?.top ?? 12, end?.top ?? start?.top ?? 12);
    const anchorBottom = Math.max(end?.bottom ?? start?.bottom ?? 12, start?.bottom ?? end?.bottom ?? 12);

    const domAtAnchor = view.domAtPos(from).node;
    const anchorElement = domAtAnchor instanceof Element ? domAtAnchor : domAtAnchor.parentElement;
    const lineElement = anchorElement?.closest('.cm-line');
    const gutterButton = preferGutter ? lineElement?.querySelector<HTMLElement>('.me-comment-gutter-badge') : undefined;
    const gutterRect = gutterButton?.getBoundingClientRect();
    const targetTop = gutterRect?.top ?? anchorTop;
    const targetBottom = gutterRect?.bottom ?? anchorBottom;

    const editorContainer = view.dom.closest<HTMLElement>('.notes-minu-editor') ?? view.dom;
    const containerRect = editorContainer.getBoundingClientRect();
    const containerLeft = Math.max(12, containerRect.left);
    const containerRight = Math.min(window.innerWidth - 12, containerRect.right);
    const containerWidth = Math.max(0, containerRight - containerLeft);
    const dialogWidth = Math.min(448, containerWidth);
    const left = containerLeft + (containerWidth - dialogWidth) / 2;

    const margin = 12;
    const gap = 8;
    const minimumUsefulHeight = 280;
    const spaceAbove = targetTop - margin - gap;
    const spaceBelow = window.innerHeight - targetBottom - margin - gap;
    const placement = spaceBelow < minimumUsefulHeight && spaceAbove > spaceBelow ? 'above' : 'below';
    const top = placement === 'above' ? targetTop - gap : targetBottom + gap;
    onCommentAnchorPosition({ top, left, placement });
  };

  const positionedComments = useMemo<CommentsProp>(() => {
    if (!comments) return undefined;
    return {
      ...comments,
      onRequest: (anchor) => {
        positionCommentDialog(anchor);
        comments.onRequest?.(anchor);
      },
      onSelect: (comment) => {
        if (comment) positionCommentDialog(comment.anchor);
        comments.onSelect?.(comment);
      },
      onSelectGroup: (items) => {
        const first = items[0];
        if (first) positionCommentDialog(first.anchor, true);
        comments.onSelectGroup?.(items);
      },
    };
  }, [comments, onCommentAnchorPosition]);

  const saveLabel =
    saveState === 'saving'
      ? 'Saving...'
      : saveState === 'unsaved'
        ? 'Unsaved changes'
        : saveState === 'error'
          ? 'Save failed'
          : 'Saved';

  const insertMarkdown = (markdown: string) => {
    editorRef.current?.insertMarkdown(markdown);
    setBlockMenuOpen(false);
  };

  const blockItems = [
    { label: 'Text', icon: Type, markdown: '' },
    { label: 'Heading 1', icon: Heading1, markdown: '# ' },
    { label: 'Heading 2', icon: Heading2, markdown: '## ' },
    { label: 'Heading 3', icon: Heading3, markdown: '### ' },
    { label: 'Bulleted list', icon: List, markdown: '- ' },
    { label: 'Numbered list', icon: ListOrdered, markdown: '1. ' },
    { label: 'To-do list', icon: ListChecks, markdown: '- [ ] ' },
    { label: 'Quote', icon: Quote, markdown: '> ' },
  ];

  const insertTable = () => {
    editorRef.current?.insertTable();
    setBlockMenuOpen(false);
  };

  const openImagePicker = () => {
    setBlockMenuOpen(false);
    setHistoryMenuOpen(false);
    setImagePickerError(null);
    setImagePickerOpen(true);
  };

  const toggleHistoryMenu = () => {
    setBlockMenuOpen(false);
    if (historyMenuOpen) {
      setHistoryMenuOpen(false);
      return;
    }

    const state = editorRef.current?.getState();
    setHistoryState({ canUndo: state?.canUndo ?? false, canRedo: state?.canRedo ?? false });
    setHistoryMenuOpen(true);
  };

  const closeImagePicker = () => {
    setImagePickerOpen(false);
    setImagePickerError(null);
    setImageUrl('');
    setImageAlt('');
    if (imageInputRef.current) imageInputRef.current.value = '';
  };

  const uploadImageFile = async (file: File | undefined) => {
    if (!file || !onImageUpload) return;
    setImagePickerError(null);
    setUploadingImage(true);
    try {
      const src = await onImageUpload(file);
      editorRef.current?.insertImage({ src, alt: imageAlt.trim() || file.name });
      closeImagePicker();
    } catch (error) {
      setImagePickerError(error instanceof Error ? error.message : 'Image upload failed');
    } finally {
      setUploadingImage(false);
    }
  };

  const insertLinkedImage = () => {
    const src = imageUrl.trim();
    if (!src) return;
    editorRef.current?.insertImage({ src, alt: imageAlt.trim() });
    closeImagePicker();
  };

  return (
    <section className="mx-auto w-full max-w-6xl">
      <div className="border-b border-[var(--notes-border)] bg-[var(--notes-bg)] pb-4 md:sticky md:-top-6 md:z-20 md:-mt-6 md:pt-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <p className="notes-muted min-w-0 text-xs">{uploadingImage ? 'Uploading image...' : saveLabel}</p>
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        </div>
        {staleNotice}
        <input
          className="w-full bg-transparent text-2xl font-semibold outline-none sm:text-3xl"
          value={titleValue}
          readOnly={readOnly}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="Untitled note"
          spellCheck={true}
          autoCorrect="on"
          autoComplete="on"
          autoCapitalize="sentences"
        />
        {updatedMeta ? <div className="notes-muted mt-2 text-xs">{updatedMeta}</div> : null}
        {headerExtra}
      </div>
      <div className="overflow-x-hidden bg-[var(--notes-bg)] pb-20 sm:pb-24">
        <div>
          <MarkdownEditor
            ref={editorRef}
            value={content}
            onChange={onContentChange}
            readOnly={readOnly}
            mode={editorMode}
            floatingToolbar
            tableActions
            tableInsertion={DEFAULT_TABLE_INSERTION}
            placeholder="Start typing..."
            minHeight={520}
            codeLanguages={editorCodeLanguages}
            codeHighlighter={editorCodeHighlighter}
            mermaid={mermaid}
            resourceUrlResolver={minuNotesResourceUrlResolver}
            spellCheck={true}
            autoCorrect="on"
            autoComplete="on"
            autoCapitalize="sentences"
            onRequestImage={onImageUpload ? () => openImagePicker() : undefined}
            wikiLinks={wikiLinks}
            comments={positionedComments}
            onImageUpload={
              onImageUpload
                ? async (file) => {
                    setUploadingImage(true);
                    try {
                      return await onImageUpload(file);
                    } finally {
                      setUploadingImage(false);
                    }
                  }
                : undefined
            }
            onViewReady={(view) => {
              setEditorReady(true);
              editorViewRef.current = view;
              editorKeydownCleanupRef.current?.();
              const positionAutocompleteAtCursor = () => {
                const tooltip = view.dom.querySelector<HTMLElement>('.cm-tooltip-autocomplete');
                if (!tooltip) return;

                const selection = view.contentDOM.ownerDocument.getSelection();
                const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
                const selectionNode = range?.startContainer;
                const caretRect =
                  range?.collapsed && selectionNode && view.contentDOM.contains(selectionNode)
                    ? range.getBoundingClientRect()
                    : undefined;
                const cursorLeft = caretRect?.height
                  ? caretRect.left
                  : view.coordsAtPos(view.state.selection.main.head, -1)?.left;
                if (cursorLeft === undefined) return;

                const width = tooltip.getBoundingClientRect().width;
                const left = Math.max(12, Math.min(cursorLeft, window.innerWidth - width - 12));

                // CodeMirror's document coordinate can temporarily resolve to the line-end gutter widget.
                // The browser caret range remains stable while that widget and the tooltip are remeasured.
                view.dom.style.setProperty('--notes-autocomplete-left', `${left}px`);
              };
              const autocompleteObserver = new MutationObserver(positionAutocompleteAtCursor);
              autocompleteObserver.observe(view.dom, { childList: true, subtree: true });
              view.dom.addEventListener('keyup', positionAutocompleteAtCursor);
              window.addEventListener('resize', positionAutocompleteAtCursor);
              window.addEventListener('scroll', positionAutocompleteAtCursor, true);

              const handlePartialTaskEnter = (event: KeyboardEvent) => {
                if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

                const selection = view.state.selection.main;
                if (!selection.empty) return;

                const line = view.state.doc.lineAt(selection.from);
                if (selection.from !== line.to) return;

                const taskMatch = line.text.match(/^(\s*)([-*+])\s+\[\/\](?:\s+(.*))?$/);
                if (!taskMatch) return;

                event.preventDefault();
                event.stopPropagation();

                const text = taskMatch[3] ?? '';
                if (text.length === 0) {
                  view.dispatch({
                    changes: { from: line.from, to: line.to, insert: '' },
                    selection: { anchor: line.from },
                    scrollIntoView: true,
                  });
                  return;
                }

                const insert = `\n${taskMatch[1]}${taskMatch[2]} [ ] `;
                view.dispatch({
                  changes: { from: line.to, insert },
                  selection: { anchor: line.to + insert.length },
                  scrollIntoView: true,
                });
              };
              const handleTaskCopy = (event: ClipboardEvent) => {
                const ranges = view.state.selection.ranges.filter((range) => !range.empty);
                if (ranges.length === 0) return;

                let expanded = false;
                const text = ranges
                  .map((range) => {
                    let from = range.from;
                    const to = range.to;
                    const fromLine = view.state.doc.lineAt(from);
                    const toLine = view.state.doc.lineAt(to);
                    const taskPrefix = fromLine.text.match(/^(\s*[-*+]\s+\[[ xX/]\]\s+)/)?.[1];

                    if (
                      taskPrefix &&
                      fromLine.number !== toLine.number &&
                      from > fromLine.from &&
                      from <= fromLine.to
                    ) {
                      from = fromLine.from;
                      expanded = true;
                    }

                    return view.state.doc.sliceString(from, to);
                  })
                  .join('\n');

                if (!expanded) return;
                event.preventDefault();
                event.stopPropagation();
                event.clipboardData?.setData('text/plain', text);
              };
              view.contentDOM.addEventListener('keydown', handlePartialTaskEnter, { capture: true });
              view.contentDOM.addEventListener('copy', handleTaskCopy, { capture: true });
              editorKeydownCleanupRef.current = () => {
                autocompleteObserver.disconnect();
                view.dom.removeEventListener('keyup', positionAutocompleteAtCursor);
                window.removeEventListener('resize', positionAutocompleteAtCursor);
                window.removeEventListener('scroll', positionAutocompleteAtCursor, true);
                view.dom.style.removeProperty('--notes-autocomplete-left');
                view.contentDOM.removeEventListener('keydown', handlePartialTaskEnter, { capture: true });
                view.contentDOM.removeEventListener('copy', handleTaskCopy, { capture: true });
                if (editorViewRef.current === view) editorViewRef.current = null;
              };
              window.requestAnimationFrame(() => {
                window.requestAnimationFrame(() => {
                  if (editorViewRef.current !== view) return;
                  view.requestMeasure();
                  view.dispatch({ selection: view.state.selection, scrollIntoView: false });
                });
              });
              if (!initialEditing && view.hasFocus) view.contentDOM.blur();
            }}
            className={`notes-minu-editor ${editorMode === 'source' ? 'notes-minu-editor--source' : ''}`}
          />
        </div>
      </div>
      {reviewPanel}
      {imagePickerOpen ? (
        <div className="fixed inset-0 z-50 grid place-items-end bg-black/40 p-0 sm:place-items-center sm:p-6">
          <div className="max-h-[min(82vh,42rem)] w-full max-w-lg overflow-hidden rounded-t-2xl border border-[var(--notes-border)] bg-[var(--notes-panel)] text-[var(--notes-text)] shadow-2xl sm:rounded-2xl">
            <div className="flex items-center justify-between border-b border-[var(--notes-border)] px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] sm:pb-3">
              <h2 className="text-sm font-semibold">Add an image</h2>
              <button
                type="button"
                className="rounded-md p-1.5 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)]"
                onClick={closeImagePicker}
                aria-label="Close image picker"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex gap-1 border-b border-[var(--notes-border)] px-4">
              <button
                type="button"
                className={`border-b-2 px-3 py-2 text-sm font-medium ${imageTab === 'upload' ? 'border-[var(--notes-blue)] text-[var(--notes-text)]' : 'border-transparent text-[var(--notes-muted)] hover:text-[var(--notes-text)]'}`}
                onClick={() => setImageTab('upload')}
              >
                Upload
              </button>
              <button
                type="button"
                className={`border-b-2 px-3 py-2 text-sm font-medium ${imageTab === 'link' ? 'border-[var(--notes-blue)] text-[var(--notes-text)]' : 'border-transparent text-[var(--notes-muted)] hover:text-[var(--notes-text)]'}`}
                onClick={() => setImageTab('link')}
              >
                Link
              </button>
            </div>
            <div className="notes-modal-scroll max-h-[calc(min(82vh,42rem)-6rem)] space-y-3 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
              <input
                className="w-full rounded-lg border border-[var(--notes-border)] bg-[var(--notes-bg)] px-3 py-3 text-base outline-none focus:border-[var(--notes-blue)] sm:py-2 sm:text-sm"
                placeholder="Alt text optional"
                value={imageAlt}
                onChange={(event) => setImageAlt(event.target.value)}
              />
              {imageTab === 'upload' ? (
                <div>
                  <input
                    ref={imageInputRef}
                    className="hidden"
                    type="file"
                    accept="image/*"
                    onChange={(event) => void uploadImageFile(event.target.files?.[0])}
                  />
                  <button
                    type="button"
                    className="w-full rounded-lg border border-[var(--notes-border)] bg-[var(--notes-bg)] px-3 py-4 text-base font-semibold hover:bg-[var(--notes-hover)] disabled:cursor-not-allowed disabled:opacity-50 sm:py-3 sm:text-sm"
                    disabled={uploadingImage || !onImageUpload}
                    onClick={() => imageInputRef.current?.click()}
                  >
                    {uploadingImage ? 'Uploading...' : 'Upload file'}
                  </button>
                  <p className="mt-2 text-center text-xs text-[var(--notes-muted)]">Choose an image from your device</p>
                </div>
              ) : (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    insertLinkedImage();
                  }}
                >
                  <input
                    className="w-full rounded-lg border border-[var(--notes-border)] bg-[var(--notes-bg)] px-3 py-3 text-base outline-none focus:border-[var(--notes-blue)] sm:py-2 sm:text-sm"
                    type="url"
                    inputMode="url"
                    placeholder="Paste the image link…"
                    value={imageUrl}
                    onChange={(event) => setImageUrl(event.target.value)}
                  />
                  <button
                    type="submit"
                    className="w-full rounded-lg border border-[var(--notes-blue)] bg-[var(--notes-blue)] px-3 py-4 text-base font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 sm:py-3 sm:text-sm"
                    disabled={!imageUrl.trim()}
                  >
                    Embed image
                  </button>
                  <p className="text-center text-xs text-[var(--notes-muted)]">Works with any image from the web</p>
                </form>
              )}
              {imagePickerError ? (
                <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
                  {imagePickerError}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      {!readOnly ? (
        <div
          className="fixed inset-x-0 bottom-3 z-40 px-3 sm:bottom-4 sm:px-6 md:left-72 md:right-0"
          style={keyboardOffset ? { bottom: keyboardOffset + 12 } : undefined}
        >
          <div ref={toolbarSurfaceRef} className="mx-auto flex max-w-3xl flex-col items-center">
            {blockMenuOpen ? (
              <fieldset
                id="note-insert-menu"
                className="mb-3 rounded-2xl border border-[var(--notes-border)] bg-[var(--notes-panel)]/95 p-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-[var(--notes-panel)]/85"
                aria-label="Insert content"
              >
                <p className="mb-2 px-1 font-medium text-[var(--notes-muted)] text-xs uppercase tracking-wide">
                  Insert
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {blockItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.label}
                        type="button"
                        className="flex items-center gap-3 rounded-lg border border-[var(--notes-border)] bg-[var(--notes-bg)] px-3 py-3 text-left font-medium text-sm hover:bg-[var(--notes-hover)]"
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => insertMarkdown(item.markdown)}
                      >
                        <Icon className="h-5 w-5 text-[var(--notes-muted)]" />
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className="flex items-center gap-3 rounded-lg border border-[var(--notes-border)] bg-[var(--notes-bg)] px-3 py-3 text-left font-medium text-sm hover:bg-[var(--notes-hover)]"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={insertTable}
                  >
                    <Table2 className="h-5 w-5 text-[var(--notes-muted)]" />
                    <span>Table</span>
                  </button>
                  {onImageUpload ? (
                    <button
                      type="button"
                      className="flex items-center gap-3 rounded-lg border border-[var(--notes-border)] bg-[var(--notes-bg)] px-3 py-3 text-left font-medium text-sm hover:bg-[var(--notes-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label="Insert image"
                      disabled={uploadingImage || !editorReady}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={openImagePicker}
                    >
                      <Image className="h-5 w-5 text-[var(--notes-muted)]" />
                      <span>Image</span>
                    </button>
                  ) : null}
                </div>
              </fieldset>
            ) : null}
            {historyMenuOpen ? (
              <fieldset
                id="note-editor-actions-menu"
                className="mb-3 grid min-w-44 gap-1 rounded-xl border border-[var(--notes-border)] bg-[var(--notes-panel)]/95 p-2 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-[var(--notes-panel)]/85"
                aria-label="Editor actions"
              >
                <button
                  type="button"
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-left font-medium text-sm hover:bg-[var(--notes-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!editorReady || !historyState.canUndo}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    editorRef.current?.undo();
                    setHistoryMenuOpen(false);
                  }}
                >
                  <Undo2 className="h-4 w-4 text-[var(--notes-muted)]" />
                  Undo
                </button>
                <button
                  type="button"
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-left font-medium text-sm hover:bg-[var(--notes-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!editorReady || !historyState.canRedo}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    editorRef.current?.redo();
                    setHistoryMenuOpen(false);
                  }}
                >
                  <Redo2 className="h-4 w-4 text-[var(--notes-muted)]" />
                  Redo
                </button>
              </fieldset>
            ) : null}
            <div className="inline-flex w-fit max-w-full items-center gap-1 rounded-full border border-[var(--notes-border)] bg-[var(--notes-panel)]/95 px-2 py-1.5 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-[var(--notes-panel)]/85">
              <button
                type="button"
                className="rounded-full p-2 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)]"
                aria-label={blockMenuOpen ? 'Close insert menu' : 'Open insert menu'}
                aria-controls={blockMenuOpen ? 'note-insert-menu' : undefined}
                aria-expanded={blockMenuOpen}
                onClick={() => {
                  setHistoryMenuOpen(false);
                  setBlockMenuOpen((open) => !open);
                }}
              >
                {blockMenuOpen ? <X className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
              </button>
              <button
                type="button"
                className="rounded-full p-2 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)]"
                aria-label={historyMenuOpen ? 'Close editor actions' : 'Open editor actions'}
                aria-controls={historyMenuOpen ? 'note-editor-actions-menu' : undefined}
                aria-expanded={historyMenuOpen}
                onClick={toggleHistoryMenu}
              >
                <MoreHorizontal className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
