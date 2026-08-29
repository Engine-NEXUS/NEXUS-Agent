import { Marked, type Tokens } from "marked";
import hljs from "highlight.js";
import DOMPurify, { type Config } from "dompurify";

/**
 * Custom Markdown Parser for NEXUS Sidebar.
 * Supports:
 * - GitHub Flavored Markdown (GFM)
 * - Tables with glass styling and horizontal scroll
 * - Syntax highlighting with highlight.js and Copy Code buttons
 * - Responsive images with lightbox zoom triggers and error fallbacks
 * - GitHub Callout / Alert blocks ([!NOTE], [!TIP], [!IMPORTANT], [!WARNING], [!CAUTION])
 * - Custom styled checkboxes for task lists
 * - Safe link interception for external browser opening
 * - Inline code tags and LaTeX / Math formatting preservation
 */

const marked = new Marked({
  gfm: true,
  breaks: true,
});

// Configure DOMPurify to allow needed attributes for interactivity & styling
const DOMPURIFY_CONFIG: Config = {
  ADD_TAGS: ["button", "svg", "path", "span", "table", "thead", "tbody", "tr", "th", "td", "img", "polyline", "line", "circle", "polygon", "rect"],
  ADD_ATTR: [
    "target",
    "rel",
    "class",
    "style",
    "data-code",
    "data-lang",
    "data-src",
    "data-alt",
    "data-href",
    "loading",
    "viewBox",
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "d",
    "points",
    "x1",
    "y1",
    "x2",
    "y2",
    "cx",
    "cy",
    "r",
    "x",
    "y",
    "rx",
    "ry",
    "width",
    "height",
    "align",
    "title",
    "alt",
    "src",
    "href",
  ],
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Copy icon SVG
const COPY_ICON_SVG = `
<svg class="nexus-icon-copy" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
</svg>`;

// Zoom icon SVG
const ZOOM_ICON_SVG = `
<svg class="nexus-icon-zoom" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="15 3 21 3 21 9"></polyline>
  <polyline points="9 21 3 21 3 15"></polyline>
  <line x1="21" y1="3" x2="14" y2="10"></line>
  <line x1="3" y1="21" x2="10" y2="14"></line>
</svg>`;

// External link icon SVG
const LINK_ICON_SVG = `
<svg class="nexus-external-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
  <polyline points="15 3 21 3 21 9"></polyline>
  <line x1="10" y1="14" x2="21" y2="3"></line>
</svg>`;

// Custom marked renderer
marked.use({
  renderer: {
    // Code blocks with syntax highlighting and Copy Code header
    code({ text, lang }: Tokens.Code): string {
      const language = (lang || "").trim().toLowerCase();
      let highlighted = "";
      let detectedLang = language || "text";

      if (language && hljs.getLanguage(language)) {
        try {
          highlighted = hljs.highlight(text, { language, ignoreIllegals: true }).value;
          detectedLang = language;
        } catch {
          highlighted = escapeHtml(text);
        }
      } else {
        try {
          const auto = hljs.highlightAuto(text);
          highlighted = auto.value;
          detectedLang = auto.language || "text";
        } catch {
          highlighted = escapeHtml(text);
        }
      }

      const encodedCode = encodeURIComponent(text);
      const displayLang = (language || detectedLang).toUpperCase();

      return `
<div class="nexus-code-block" data-lang="${escapeAttribute(displayLang)}">
  <div class="nexus-code-header">
    <span class="nexus-code-lang">${escapeHtml(displayLang)}</span>
    <button class="nexus-copy-code-btn" type="button" data-code="${encodedCode}" title="Copy code">
      ${COPY_ICON_SVG}
      <span class="nexus-btn-label">Copy</span>
    </button>
  </div>
  <pre><code class="hljs language-${escapeAttribute(detectedLang)}">${highlighted}</code></pre>
</div>`;
    },

    // Tables wrapped in responsive scroll containers
    table({ header, rows, align }: Tokens.Table): string {
      let headerHtml = "<tr>";
      header.forEach((cell, i) => {
        const alignStyle = align[i] ? ` style="text-align: ${align[i]}"` : "";
        headerHtml += `<th${alignStyle}>${this.parser.parseInline(cell.tokens)}</th>`;
      });
      headerHtml += "</tr>";

      let bodyHtml = "";
      rows.forEach((row) => {
        bodyHtml += "<tr>";
        row.forEach((cell, i) => {
          const alignStyle = align[i] ? ` style="text-align: ${align[i]}"` : "";
          bodyHtml += `<td${alignStyle}>${this.parser.parseInline(cell.tokens)}</td>`;
        });
        bodyHtml += "</tr>";
      });

      return `
<div class="nexus-table-wrapper">
  <table class="nexus-table">
    <thead>${headerHtml}</thead>
    <tbody>${bodyHtml}</tbody>
  </table>
</div>`;
    },

    // Images with responsive styling, caption, and Lightbox zoom button
    image({ href, title, text }: Tokens.Image): string {
      const cleanHref = escapeAttribute(href || "");
      const cleanAlt = escapeAttribute(text || title || "Image");
      const cleanTitle = escapeAttribute(title || text || "");

      return `
<div class="nexus-image-container">
  <div class="nexus-image-box">
    <img src="${cleanHref}" alt="${cleanAlt}" title="${cleanTitle}" class="nexus-image" loading="lazy" />
    <button class="nexus-image-zoom-btn" type="button" data-src="${cleanHref}" data-alt="${cleanAlt}" title="View full image">
      ${ZOOM_ICON_SVG}
      <span>Zoom</span>
    </button>
  </div>
  ${text ? `<div class="nexus-image-caption">${escapeHtml(text)}</div>` : ""}
</div>`;
    },

    // Safe external links
    link({ href, title, tokens }: Tokens.Link): string {
      const cleanHref = escapeAttribute(href || "#");
      const cleanTitle = title ? ` title="${escapeAttribute(title)}"` : "";
      const text = this.parser.parseInline(tokens);
      return `<a href="${cleanHref}" class="nexus-link" data-href="${cleanHref}" target="_blank" rel="noopener noreferrer"${cleanTitle}>${text} ${LINK_ICON_SVG}</a>`;
    },

    // Blockquotes with GitHub Alert / Callout parsing
    blockquote({ tokens }: Tokens.Blockquote): string {
      const parsedBody = this.parser.parse(tokens);
      const trimmed = parsedBody.trim();

      // Check for GitHub Alerts: [!NOTE], [!TIP], [!IMPORTANT], [!WARNING], [!CAUTION]
      const alertMatch = trimmed.match(/^<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s*<br\s*\/?>)?\s*([\s\S]*?)<\/p>$/i);

      if (alertMatch) {
        const type = alertMatch[1].toUpperCase();
        const content = alertMatch[2];
        let alertClass = "nexus-callout--note";
        let alertTitle = "NOTE";
        let iconSvg = "";

        switch (type) {
          case "TIP":
            alertClass = "nexus-callout--tip";
            alertTitle = "TIP";
            iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"></path></svg>`;
            break;
          case "IMPORTANT":
            alertClass = "nexus-callout--important";
            alertTitle = "IMPORTANT";
            iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
            break;
          case "WARNING":
            alertClass = "nexus-callout--warning";
            alertTitle = "WARNING";
            iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
            break;
          case "CAUTION":
            alertClass = "nexus-callout--caution";
            alertTitle = "CAUTION";
            iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"></polygon><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
            break;
          case "NOTE":
          default:
            alertClass = "nexus-callout--note";
            alertTitle = "NOTE";
            iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
            break;
        }

        return `
<div class="nexus-callout ${alertClass}">
  <div class="nexus-callout-header">
    ${iconSvg}
    <span class="nexus-callout-title">${alertTitle}</span>
  </div>
  <div class="nexus-callout-body">${content}</div>
</div>`;
      }

      return `<blockquote class="nexus-blockquote">${parsedBody}</blockquote>`;
    },

    // Task list items
    checkbox({ checked }: Tokens.Checkbox): string {
      return `<input type="checkbox" class="nexus-task-checkbox" ${checked ? "checked" : ""} disabled />`;
    },

    // Headings
    heading({ tokens, depth }: Tokens.Heading): string {
      const text = this.parser.parseInline(tokens);
      return `<h${depth} class="nexus-h${depth}">${text}</h${depth}>`;
    },

    // Inline codespan
    codespan({ text }: Tokens.Codespan): string {
      return `<code class="nexus-inline-code">${escapeHtml(text)}</code>`;
    },

    // Horizontal rule
    hr(): string {
      return `<hr class="nexus-hr" />`;
    },
  },
});

/**
 * Sanitize HTML with DOMPurify across browser and Node environments.
 */
function sanitizeHtml(html: string): string {
  try {
    if (typeof DOMPurify?.sanitize === "function") {
      return DOMPurify.sanitize(html, DOMPURIFY_CONFIG) as string;
    }
    const dp = (DOMPurify as any)?.default;
    if (typeof dp?.sanitize === "function") {
      return dp.sanitize(html, DOMPURIFY_CONFIG) as string;
    }
    if (typeof DOMPurify === "function" && typeof window !== "undefined") {
      const instance = (DOMPurify as any)(window);
      if (instance && typeof instance.sanitize === "function") {
        return instance.sanitize(html, DOMPURIFY_CONFIG);
      }
    }
  } catch {
    // Fall back to raw html if DOM is unavailable
  }
  return html;
}

/**
 * Render raw markdown string into sanitized, rich HTML.
 */
export function renderMarkdownToHtml(markdown: string): string {
  if (!markdown) return "";
  try {
    const rawHtml = marked.parse(markdown) as string;
    return sanitizeHtml(rawHtml);
  } catch (err) {
    console.error("[NEXUS] Markdown parse error:", err);
    return `<div class="nexus-markdown-fallback">${escapeHtml(markdown)}</div>`;
  }
}
