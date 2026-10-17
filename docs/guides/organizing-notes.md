# Organizing Notes

MinuNotes combines folders and links with folder-defined properties for structured labels. Tags remain optional for cross-cutting labels and compatibility.

## Folders

Use folders for broad areas of work, projects, or access boundaries. Folder permissions also control what API keys and agents can read, edit, create, or organize.

Agents with an appropriately scoped API key can move notes into subfolders they can create in. A project-root scoped key keeps agent organization work inside that project; broader keys can move notes across granted roots.

Use **Folder menu → Duplicate** to copy any folder you own to Root or another owned folder. Choose a name and destination; notes, canvases, subfolders, properties/options, Board setup, tags, assigned templates (including independent copies of templates stored elsewhere), defaults and referenced images are copied. Internal ID links are remapped; the original is not edited. Sharing links, direct permissions, review/history and personal query/view state are not copied; destination access still applies and privacy/agent protections are preserved. If the response is uncertain, **Retry duplication** retries the same request rather than creating a second copy. Review the copy summary (notes/templates, subfolders and uploaded-image count/size) before confirming. Copies are limited to 100 notes/templates combined, including imported templates, and 25 MB of uploaded images; there is no large-copy override. The existing 100-folder, 200-image, 10 MB per-image, 16 MB content/metadata and depth limits also apply. Larger copies are rejected rather than truncated. If the source or destination changes, refresh the summary and explicitly confirm again. Uploaded images receive independent files; external website images remain links. Resolved title links are pinned in the copy; title-only links elsewhere can become ambiguous when names repeat, so prefer ID-based links for reusable bases.

## Wikilinks and backlinks

Use wikilinks to connect related notes:

```md
[[Project Plan]]
[[Project Plan|the plan]]
```

When a note links to another note, MinuNotes indexes that relationship and shows backlinks on the target note. Backlinks help answer “what references this?” without manually maintaining lists.

## Tags

Tags are optional lightweight labels for cross-cutting organization. Prefer defined Select properties for structured Status/Type labels; do not mirror them into tags unless wanted. Agents should use stable property/option IDs and ask when definitions are missing, rather than invent tags, fields or choices. Preserve existing and reviewed template tags. They are useful when a note belongs to more than one category.

Examples:

- `plan`
- `research`
- `oauth`
- `release-notes`

Tag names are normalized to lowercase words with optional dashes. For example, `Release Notes` becomes `release-notes`.

Tags are managed from **Note actions → Details**. Tags are reusable, and unused tags disappear automatically after no notes use them.

## Note details

The Details panel includes built-in metadata:

- Name
- Folder
- Type
- Created date
- Updated date
- Updated by
- API editable
- Tags

## Properties

Folder owners can add **Text**, **Select** and **Date** fields in **Folder settings → Properties**. Each folder has its own schema, with no inheritance. Limits are 12 active fields, 1–8 active Select options, 80-character labels and 1,000-character Text values.

Open **Properties** outside a Markdown, canvas or mind-map editor to view values. Owners and editors can save values or Clear them; viewers and commenters can only read. Date values are real calendar dates without times.

Rename and reorder preserve IDs. Types cannot change; archive a field to retire it without destroying its values. Select option menus instead offer **Delete option**: review the exact affected-note count, then confirm to permanently remove the option and clear its values. Notes are not deleted. This includes retained values on moved notes and notes in Trash, plus matching template defaults disclosed separately in confirmation. Keep at least one active option. The options popup stays open after adding or deleting an option.

Previously archived choices and choices archived through the existing API retain their non-destructive behavior: assigned values remain labeled but cannot be newly assigned. There is no automatic cleanup of historical archives. Moving a note otherwise retains its old values invisibly; moving back restores matching active fields. Trash/restore otherwise preserves metadata.

Properties are independent of body bytes/hash, tags and body-version restores. Conflicts keep your local properties draft until you reload/review it. Public shares omit properties. A property edit can change a Select-backed board column on refresh; it never changes ordinary note tags. Disable or switch an enabled board before archiving its grouping property.

## Template defaults and reviewed creation

Markdown templates remain reusable across folders. Owners edit **Default tags** in the template editor and choose an assigned destination for **Default properties**. Tags are template-level defaults, not indexed tags on the template; properties use that destination's stable field/option IDs. Defaults and body save independently and never change existing instances. Clear referenced defaults or remove their assignment before archiving a field (or archiving a choice through the existing API), including references retained in Trash. Confirmed **Delete option** clears only that option's matching defaults automatically, including retained assignments whose templates are in Trash; other defaults and assignments stay intact.

Use folder → New from template, enter a title and review the body, final tags and properties. Change or clear any defaults before creating. Cancel creates nothing. Owner/editor access to the destination permits only assigned previews, not general access to private template storage; viewers/commenters cannot create. Blank notes have no hidden defaults. The original title/date/time/datetime substitutions are retained with review-time date/time frozen.

Creation saves the ordinary note, metadata and one create event atomically. A stale review keeps your draft for explicit re-review. An uncertain response locks the frozen request for **Retry creation**; retry does not create a second note. The normal editor opens on success. On refresh, the folder board groups the instance by its selected Select property.

## Folder search and filters

**Search titles in this folder** and **Filter** apply to the folder's direct active notes, including canvases, in both List and Board. They do not search bodies, tags, folder names, child folders, templates or Trash. List search does not require an enabled Board. Subfolders remain navigation even when no notes match.

Title search applies after 300 ms idle, or immediately with Enter. Clear search keeps property filters. Use **Add property** to choose an existing folder property, then select its row to edit it. Text supports **contains / is empty**, Select offers searchable inclusive checkboxes or **is empty**, and Date supports **before / after / between / is empty**. Any checked Select value matches (up to eight); different properties combine with AND. Sidebar badges count draft selections; the toolbar badge counts applied properties. Searching options does not deselect hidden choices. Before/after are exclusive; between includes both real YYYY-MM-DD endpoints. Empty means absent/null/blank, not invalid historical values. Text contains searches the full property, including text beyond a card preview. Matching is literal, not wildcard/regex; ASCII case-insensitivity is supported, with no promised Unicode case folding.

Apply commits valid filters; Cancel, Escape and closing the panel discard drafts. **Clear** removes the selected draft property's condition; **Clear all** clears draft property conditions. Neither changes results until Apply. Unchecking a Select property's last option clears that condition on Apply; incomplete Text/Date inputs still require correction or explicit clearing. The toolbar's **Clear filters** immediately clears applied property conditions. All clears keep title search. Summaries use current property/option names; each condition can be removed. Archived, deleted or changed fields/options block that query until explicitly reviewed or removed—Refresh definitions never silently drops them. There are at most 12 property conditions, 200 characters per search/contains term, and an 8 KiB encoded query budget; shorten an oversized query rather than losing conditions.

**Sort by** is personal URL state shared between this folder's List and Board presentations, not shared Board settings. Choose a field from the searchable picker (Title, Updated, Created, or any active Text/Date/Select folder property), then use Ascending or Descending in the compact sort row. Hidden card properties can be sorted too. Text uses the full stored value, Date uses real calendar dates, and Select follows the owner's configured option order—not alphabetical labels. New property sorts start ascending. Empty, invalid and retired-option values remain last in either direction; sorting does not remove those notes. Equal property values use Title then stable ID tie-breaks. An archived/deleted/retyped sort property blocks results until you explicitly change or remove it; refreshing definitions never silently resets sorting. Option reorders take effect with refreshed schema and reset pagination. Dates descend newest-first; titles ascend A–Z. The active toolbar chip shows the field and direction arrow. Remove the sort with × to restore the default, Updated newest-first. Only one sort is supported. Sorting applies immediately, globally before pagination; Board orders each column independently. Stable ID tie-breaks keep equal values deterministic, but concurrent edits can still shift offset pages. Title uses the database's existing ordering, not locale-aware sorting. Explicit sorts keep subfolders as navigation above the ordered notes. Search/filter clears retain sort; selecting the default removes the sort parameter. Reload and Back/Forward restore it; unrelated folder navigation starts clean. No multi-sort, relationship-specific ordering or swimlanes are included.

The query is temporary viewer-owned URL state, not shared Board settings or saved filters. Switching List/Board preserves it; query changes reset pagination and selection. Back/Forward and reload restore it. List URLs omit `view=list`; Board adds `view=board`. Unrelated folder navigation starts without the previous folder's query. Links expose their literal terms in normal URL/history infrastructure, but grant no access. No queries are stored in localStorage or Board JSON. These folder filters do not change the separate global search.

Both views filter before pagination; Board keeps all columns and shows **No matching notes in this column** for empty matches. Loaded Board counts (including `N+`) are not totals. Card visibility remains independent of filtering: any current supported property can be filtered, including hidden fields and the grouping field. Searching, applying or clearing filters never writes notes, values or configuration.

## Read-only folder boards

Open the folder's **Board** view. Boards group only by a Select property. In **Board settings**, choose **Columns**, check any existing **Card properties** to display, and save explicitly. New drafts suggest an active Status field for grouping but start with no extra card properties; otherwise choose any active Select. If none exists, use **Folder settings → Properties → Add property**. Opening settings creates nothing and never changes notes.

Tag-based grouping, lane mappings and board tag filters are retired. Old tag boards or boards with saved tag constraints stay unavailable until the owner reviews and explicitly saves property-only settings; no invisible filters or automatic widening of results. Existing property boards with no tag constraints retain equivalent behavior without a background save. Old tag-filter URLs no longer filter cards. Ordinary note tags, template tag defaults and note-tag tools elsewhere are unchanged.

**Card properties** can show up to 12 existing Text, Select and Date fields as neutral label/value rows, in folder-property order. Empty or unavailable values are hidden. Text previews are bounded to 160 characters and two visual lines; open the note for the full value. Dates display as YYYY-MM-DD. Grouping is hidden on cards unless explicitly selected. Save board applies visibility for everyone; Cancel changes nothing. Visibility never changes note values, grouping, counts or access. Existing single-property choices carry forward without rewriting stored settings on read. This version 4 config/API requires coordinated frontend/backend delivery; old clients cannot safely edit the new configuration. No database migration is needed. Display selections add no archive guard (grouping and template-reference guards still apply). Cards do not fetch or display note tags.

Select option definitions own column labels/order, including empty columns. Deleting an option clears its values: affected notes show **Not set**, and eligible board cards remain visible in **Unclassified** with **No property value**. Cleared Type values no longer show a Type badge. Unset and historically archived/unavailable values appear in Unclassified with a reason. Only direct active notes/canvases are shown, not templates, Trash or child folders. Loaded counts are not totals; use Load more and Refresh. Schema/config changes require a fresh whole-board snapshot; concurrent edits can shift offset pages. Conflicting settings drafts remain until explicit Refresh and review. No dragging, column creation or board-originated note writes.

## Agent-friendly graph data

Agents can use the harness API to inspect note relationships:

- Backlinks: notes that reference a note.
- Outgoing links: notes a note references.
- Orphans: notes with no incoming links.
- Tags: lightweight labels for filtering/search.

This lets agents gather context without scraping the UI.
