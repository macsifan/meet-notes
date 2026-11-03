/**
 * Маленький конвертер markdown → HTML для просмотра заметок в браузере.
 * Поддерживает ровно то, что генерирует render.mjs: заголовки, списки,
 * цитаты, жирный текст и сворачиваемый транскрипт.
 */

/** Теги, которые render.mjs вставляет намеренно, — единственный HTML, который пропускается как есть. */
const ALLOWED_TAGS = ['details', 'summary'];

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Разметка строки разбирается по сырому тексту, а экранируется уже её содержимое. */
function content(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function isAllowedTag(line) {
  return ALLOWED_TAGS.some((tag) => line.startsWith(`<${tag}`) || line.startsWith(`</${tag}`));
}

/**
 * Достаёт из готовой заметки название встречи и строку с временем —
 * это то, что показывается в списке заметок.
 * @param {string} markdown
 * @returns {{title: string|null, when: string|null}}
 */
export function extractNoteHeader(markdown) {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
  const when = markdown.match(/^\*\*(.+?)\*\*(.*)$/m);

  return {
    title,
    when: when ? `${when[1]}${when[2]}`.trim() : null,
  };
}

/**
 * @param {string} markdown
 * @returns {string} HTML
 */
export function markdownToHtml(markdown) {
  const html = [];
  let listOpen = false;

  const closeList = () => {
    if (listOpen) {
      html.push('</ul>');
      listOpen = false;
    }
  };

  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${content(heading[2])}</h${level}>`);
      continue;
    }

    if (trimmed === '---') {
      closeList();
      html.push('<hr />');
      continue;
    }

    if (trimmed.startsWith('> ')) {
      closeList();
      html.push(`<blockquote>${content(trimmed.slice(2))}</blockquote>`);
      continue;
    }

    if (trimmed.startsWith('- ')) {
      if (!listOpen) {
        html.push('<ul>');
        listOpen = true;
      }
      html.push(`<li>${content(trimmed.slice(2))}</li>`);
      continue;
    }

    if (isAllowedTag(trimmed)) {
      closeList();
      html.push(trimmed);
      continue;
    }

    closeList();
    html.push(`<p>${content(trimmed)}</p>`);
  }

  closeList();
  return html.join('\n');
}
