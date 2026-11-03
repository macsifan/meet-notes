/**
 * Маленький конвертер markdown → HTML для просмотра заметок в браузере.
 * Поддерживает ровно то, что генерирует render.mjs: заголовки, списки,
 * цитаты, жирный текст и сворачиваемый транскрипт.
 */

/**
 * Экранирует и кавычки: результат вставляется не только в текст, но и в <title>
 * и атрибуты, а название встречи задаёт её организатор — это чужой ввод.
 */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Разметка строки разбирается по сырому тексту, а экранируется уже её содержимое. */
function content(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/**
 * Сворачиваемые блоки, которые render.mjs вставляет намеренно, — единственный
 * HTML, который пропускается. Строки сверяются целиком, без атрибутов: в заметку
 * попадают выжимка модели и транскрипт, и «<details open onclick=…>» оттуда
 * должен остаться текстом. Текст внутри <summary> экранируется.
 * @returns {string|null}
 */
function allowedTag(line) {
  if (line === '<details>' || line === '</details>') return line;
  const summary = line.match(/^<summary>([^<>]*)<\/summary>$/);
  return summary ? `<summary>${escapeHtml(summary[1])}</summary>` : null;
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

    const tag = allowedTag(trimmed);
    if (tag) {
      closeList();
      html.push(tag);
      continue;
    }

    closeList();
    html.push(`<p>${content(trimmed)}</p>`);
  }

  closeList();
  return html.join('\n');
}
