/** Escapes untrusted text for insertion into XML markup. */
export const escapeText = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")

/** Escapes untrusted text for insertion into an XML attribute. */
export const escapeAttribute = escapeText
