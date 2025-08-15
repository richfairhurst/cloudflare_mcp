#!/usr/bin/env python3
"""
md_to_kv_bulk.py — Convert Markdown sections to Wrangler KV bulk format.

Default behavior:
- Split the Markdown by a chosen heading level (default: H2, i.e. '## Section').
- For each section, write one KV record:
    key   -> slug(section title)
    value -> the section's Markdown content (as a single string), preserving subheadings/body.

Optional:
- --flatten: also emit keys for subsections as path-like keys, e.g.:
    parent/child/grandchild
  where each value is the Markdown under that heading only.
- --level N: choose which heading level defines "top-level sections" (default 2).
- --slug/--no-slug: slugify keys (default: slug).
- --prefix PFX: prepend all keys with "PFX/".
- --ndjson: output NDJSON instead of a JSON array.
"""

import argparse
import json
import re
import sys
from typing import List, Tuple, Optional

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)\s*$")

def slugify(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s

class Node:
    def __init__(self, level: int, title: str):
        self.level = level
        self.title = title.strip()
        self.content_lines: List[str] = []
        self.children: List["Node"] = []

    def add_content(self, line: str):
        self.content_lines.append(line)

    def content(self) -> str:
        # Trim trailing blank lines for neatness
        lines = self.content_lines[:]
        while lines and not lines[-1].strip():
            lines.pop()
        return "\n".join(lines)

def parse_markdown(md_text: str) -> Node:
    """
    Parse Markdown into a simple heading tree.
    Returns a virtual root node at level 0 with children for each top heading.
    """
    root = Node(0, "ROOT")
    stack: List[Node] = [root]

    for raw_line in md_text.splitlines():
        m = HEADING_RE.match(raw_line)
        if m:
            hashes, title = m.groups()
            level = len(hashes)

            # Pop to parent with lower level
            while stack and stack[-1].level >= level:
                stack.pop()

            node = Node(level, title)
            stack[-1].children.append(node)
            stack.append(node)
        else:
            stack[-1].add_content(raw_line)

    return root

def collect_sections_top_level(root: Node, top_level: int) -> List[Tuple[List[str], str]]:
    """
    Return list of (path_titles, content) for each section that matches top_level.
    path_titles: [title] (a single element), but kept as list for consistency.
    """
    out: List[Tuple[List[str], str]] = []

    def walk(node: Node):
        for child in node.children:
            if child.level == top_level:
                out.append(([child.title], _section_content_with_children(child)))
            # Continue walking regardless, in case the file doesn’t strictly follow the chosen top_level
            walk(child)

    walk(root)
    return out

def _section_content_with_children(node: Node) -> str:
    """
    Return the Markdown for a node including its own content and all child headings/content,
    preserving the structure (reconstruct child headings with the same # level).
    """
    parts: List[str] = []
    # Add this node's own content
    if node.content().strip():
        parts.append(node.content().strip())

    # Add children with their headings reconstructed
    for child in node.children:
        heading = "#" * child.level + " " + child.title
        block = [heading]
        content = _section_content_with_children(child)
        if content:
            block.append(content)
        parts.append("\n".join(block).strip())

    # Join blocks separated by a blank line
    return "\n\n".join(p for p in parts if p)

def collect_sections_flatten(root: Node, start_level: int) -> List[Tuple[List[str], str]]:
    """
    Produce (path_titles, content) for every heading at level >= start_level,
    where path_titles is the chain of titles from the nearest ancestor at start_level
    down to the node itself.
    Each node's content is ONLY that node's own content (not children).
    """
    out: List[Tuple[List[str], str]] = []

    # Track the path of titles keyed by level
    title_path: dict[int, str] = {}

    def walk(node: Node):
        if node.level >= start_level:
            title_path[node.level] = node.title
            # Build path from nearest ancestor at start_level up to this node
            levels = sorted([lvl for lvl in title_path if lvl >= start_level])
            path_titles = [title_path[lvl] for lvl in levels]
            out.append((path_titles, node.content().strip()))
        for child in node.children:
            walk(child)
        # Cleanup on unwind
        if node.level in title_path:
            title_path.pop(node.level, None)

    walk(root)
    return out

def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Convert Markdown to Wrangler KV bulk format.")
    p.add_argument("input", nargs="?", default="README.md", help="Input Markdown file (default: README.md)")
    p.add_argument("output", nargs="?", default="kv_bulk.json", help="Output file (default: kv_bulk.json)")
    p.add_argument("--level", type=int, default=2, help="Heading level to treat as top-level sections (default: 2)")
    p.add_argument("--flatten", action="store_true",
                   help="Emit separate KV entries for subsections (path keys like parent/child).")
    p.add_argument("--no-slug", action="store_true", help="Do NOT slugify keys; use titles verbatim.")
    p.add_argument("--prefix", default="", help="Optional key prefix (e.g., 'profile'); becomes 'profile/<key>'.")
    p.add_argument("--ndjson", action="store_true", help="Emit NDJSON (one JSON object per line).")
    p.add_argument("--pretty", action="store_true", help="Pretty-print JSON array output.")
    args = p.parse_args(argv)

    try:
        text = open(args.input, "r", encoding="utf-8").read()
    except Exception as e:
        print(f"Failed to read {args.input}: {e}", file=sys.stderr)
        return 1

    root = parse_markdown(text)

    if args.flatten:
        entries = collect_sections_flatten(root, start_level=args.level)
        # In flatten mode, each node’s own content only; skip empty nodes to avoid noise
        entries = [(path, content) for (path, content) in entries if content.strip()]
    else:
        entries = collect_sections_top_level(root, top_level=args.level)

    def key_from_path(path_titles: List[str]) -> str:
        def norm(s: str) -> str:
            return s if args.no_slug else slugify(s)
        key = "/".join(norm(t) for t in path_titles if t.strip())
        if args.prefix:
            key = f"{args.prefix.rstrip('/')}/{key}"
        return key

    bulk = []
    for path_titles, content in entries:
        key = key_from_path(path_titles)
        value = content  # store markdown as-is
        bulk.append({"key": key, "value": value})

    try:
        if args.ndjson:
            with open(args.output, "w", encoding="utf-8") as f:
                for item in bulk:
                    f.write(json.dumps(item, ensure_ascii=False) + "\n")
        else:
            with open(args.output, "w", encoding="utf-8") as f:
                json.dump(bulk, f, ensure_ascii=False, indent=2 if args.pretty else None)
    except Exception as e:
        print(f"Failed to write {args.output}: {e}", file=sys.stderr)
        return 1

    print(f"Wrote {len(bulk)} KV records → {args.output}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

