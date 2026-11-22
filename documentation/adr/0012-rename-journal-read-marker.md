# A move of a rename journal is applied one time, by a read marker in the content store

Each device appends its renames to its own journal, which travels with the vault (ADR 0007). A publication must know which lines it already applied: an old line of a path that another note took later would else move that note, and its candidate would go live with no selection.

Considered: the time at which the note got its path, in its manifest entry, with only the later lines applied. Rejected, because a device with a wrong clock can apply an old line of another note. Considered: each device deletes the lines that a publication applied. Rejected, because a device that is off keeps old lines, and two devices would edit one file through the synchronization.

Chosen (decision of the author R66, issue 37): the content store holds `renames.json`, the number of lines of each journal that the publications read and the hash of their bytes. Each publication reads the later lines, applies them in the order of their times, and writes the new counts in its commit. A move is always applied, as a forced removal: it moves the published version as it is, so it needs no selection and puts no new text live.

Consequence: a journal that was cut or edited applies none of its lines; its notes then show as missing, and as pairings to confirm. The order of the lines of two devices still follows their clocks.
