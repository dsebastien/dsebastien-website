# The vault path is the canonical URL of a note, for good

The canonical URL of a note stays the URL that Obsidian Publish gives it today: the vault path, each segment percent-encoded, spaces written as `+`. A shorter form (the file name alone, or a slug) was considered and rejected: many external sites, and the author's own articles and newsletters, link to the current URLs, and the author does not accept any risk for them.

Consequence: the folder structure of the vault is part of the public interface. A move or rename of a note or folder is handled by redirects from former paths, which the manifest records. Other forms that work today (file name alone, alias, other letter case, `.md` suffix) redirect to the canonical URL.

Changed by ADR 0010: a note that also exists on the main site names the post there as its original, in its canonical link for search engines. The note is still served under its vault path, and every rule about redirects stays.
