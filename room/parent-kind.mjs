// 親の配送種別を通常席と区別する共通判定。旧方式は移行・診断対象として残す。
export const isParentMember = member => ['parent_receiver', 'parent_watch'].includes(member?.delivery?.kind)
export const parentRecipients = members => members.filter(isParentMember).map(member => member.name)
