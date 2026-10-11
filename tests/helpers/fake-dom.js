/**
 * A minimal stand-in for the browser DOM, just enough to test the extractor.
 *
 * Using a real headless browser would be slower and would add a dependency for the sake
 * of a handful of assertions. The extractor only ever uses querySelectorAll, contains, tagName,
 * className, id, textContent, parentElement, hidden, and getAttribute — so those are
 * what this provides.
 */

class FakeElement {
  constructor(tagName, attributes = {}, children = []) {
    this.tagName = tagName.toUpperCase();
    this.attributes = attributes;
    this.children = [];
    this.parentElement = null;
    this.ownText = '';

    for (const child of children) this.append(child);
  }

  append(child) {
    if (typeof child === 'string') {
      this.ownText += child;
      return this;
    }
    child.parentElement = this;
    this.children.push(child);
    return this;
  }

  get className() {
    return this.attributes.class ?? '';
  }

  get id() {
    return this.attributes.id ?? '';
  }

  get hidden() {
    return this.attributes.hidden === true;
  }

  getAttribute(name) {
    const value = this.attributes[name];
    return value === undefined ? null : value;
  }

  /** True for the element itself and anything beneath it, as the real DOM has it. */
  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentElement;
    }
    return false;
  }

  get textContent() {
    const nested = this.children.map((child) => child.textContent).join(' ');
    return [this.ownText, nested].filter((part) => part !== '').join(' ');
  }

  /** Walks the subtree in document order and keeps whatever matches. */
  querySelectorAll(selector) {
    const matchers = selector.split(',').map((part) => compile(part.trim()));
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (matchers.some((matches) => matches(child))) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

/** Supports the selector forms the extractor actually uses. */
function compile(selector) {
  if (selector.startsWith('.')) {
    const wanted = selector.slice(1);
    return (element) => element.className.split(/\s+/).includes(wanted);
  }
  if (selector.startsWith('#')) {
    const wanted = selector.slice(1);
    return (element) => element.id === wanted;
  }
  if (selector.startsWith('[')) {
    const [, name, value] = /^\[([\w-]+)="?([^"\]]*)"?\]$/.exec(selector) ?? [];
    return (element) => element.getAttribute(name) === value;
  }
  const wanted = selector.toUpperCase();
  return (element) => element.tagName === wanted;
}

/** Build an element: el('p', 'text') or el('div', {class: 'x'}, [children]) */
export function el(tagName, attributesOrChild, children) {
  if (typeof attributesOrChild === 'string') {
    return new FakeElement(tagName, {}, [attributesOrChild]);
  }
  return new FakeElement(tagName, attributesOrChild ?? {}, children ?? []);
}

/** Build a document whose body holds `children`. */
export function fakeDocument(children, { title = '', lang = 'en' } = {}) {
  const body = new FakeElement('body', {}, children);
  const html = new FakeElement('html', { lang }, [body]);
  return {
    title,
    documentElement: html,
    body,
    querySelectorAll(selector) {
      const matchers = selector.split(',').map((part) => compile(part.trim()));
      const found = [];
      if (matchers.some((matches) => matches(body))) found.push(body);
      return found.concat(body.querySelectorAll(selector));
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
  };
}
