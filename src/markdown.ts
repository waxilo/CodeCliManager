import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({
	gfm: true,
	breaks: true,
});

/**
 * Render Markdown to sanitized HTML for message display.
 */
export function renderMarkdown(text: string): string {
	const raw = marked.parse(text, { async: false }) as string;
	return DOMPurify.sanitize(raw, {
		USE_PROFILES: { html: true },
	});
}
