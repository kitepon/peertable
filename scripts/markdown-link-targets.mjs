import path from 'node:path'
import { parseFragment } from 'parse5'
import parseSrcset from 'parse-srcset'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const markdownParser = unified().use(remarkParse).use(remarkGfm)

/** CommonMark/GFMとして有効なMarkdown・HTMLリンクを出現位置つきで列挙する。 */
export function markdownLinkTargets(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('markdown must be a string')

  const tree = markdownParser.parse(markdown)
  const definitions = new Map()
  walkMarkdown(tree, (node) => {
    if (node.type === 'definition' && typeof node.identifier === 'string'
      && typeof node.url === 'string' && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url)
    }
  })

  const targets = []
  walkMarkdown(tree, (node) => {
    const line = node.position?.start?.line ?? 1
    if ((node.type === 'link' || node.type === 'image') && typeof node.url === 'string') {
      targets.push({ line, target: node.url })
    } else if ((node.type === 'linkReference' || node.type === 'imageReference')
      && typeof node.identifier === 'string') {
      const target = definitions.get(node.identifier)
      if (target !== undefined) targets.push({ line, target })
    } else if (node.type === 'html' && typeof node.value === 'string') {
      targets.push(...htmlLinkTargets(node.value, line))
    }
  })
  return targets
}

/** 外部URLとfragmentを除外し、Markdownファイル基準のpackage内pathへ解決する。 */
export function relativeMarkdownTarget(markdownPath, rawTarget) {
  const target = rawTarget.trim()
  if (target.length === 0 || target.startsWith('#') || target.startsWith('/')
    || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)) return null

  const pathname = target.split('#', 1)[0].split('?', 1)[0]
  if (!pathname) return null

  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    throw new TypeError(`Markdown targetのpercent encodingが不正です: ${target}`)
  }

  return path.posix.normalize(path.posix.join(path.posix.dirname(markdownPath), decoded))
    .replace(/\/+$/u, '')
}

function htmlLinkTargets(html, baseLine) {
  const targets = []
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true })
  walkHtml(fragment, (node) => {
    for (const attribute of node.attrs ?? []) {
      if (attribute.name !== 'href' && attribute.name !== 'src' && attribute.name !== 'srcset') {
        continue
      }
      const offset = node.sourceCodeLocation?.attrs?.[attribute.name]?.startLine ?? 1
      const line = baseLine + offset - 1
      if (attribute.name === 'srcset') {
        targets.push(...parseSrcset(attribute.value).map(candidate => ({
          line,
          target: candidate.url,
        })))
      } else {
        targets.push({ line, target: attribute.value })
      }
    }
  })
  return targets
}

function walkMarkdown(node, visit) {
  visit(node)
  for (const child of node.children ?? []) walkMarkdown(child, visit)
}

function walkHtml(node, visit) {
  visit(node)
  for (const child of node.childNodes ?? []) walkHtml(child, visit)
  if (node.content) walkHtml(node.content, visit)
}
