import { pathToFileURL } from 'node:url'
import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { contentStoreFolder, notesFolder } from './content-store.ts'

// The cleaned notes of the content store, as a content collection. A build
// without a content store has an empty collection: that is the state of the
// public CI, which never sees the content store.
const loader =
    contentStoreFolder() === undefined
        ? { name: 'no-content-store', load: () => Promise.resolve() }
        : glob({
              pattern: '**/*.md',
              // A URL, not a path: Astro reads a Windows path (`C:\...`) as a
              // URL with the scheme `c:`, and the build stops.
              base: pathToFileURL(notesFolder()),
              // The id of an entry is its vault path, as it is. The default id is
              // a slug, and two vault paths can give the same slug.
              generateId: ({ entry }) => entry
          })

export const collections = { notes: defineCollection({ loader }) }
