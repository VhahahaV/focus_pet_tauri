"""Regenerate the offline heading-font subset from a locally supplied upstream TTF."""
from pathlib import Path
import sys
from fontTools import subset
from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parents[1]
font = TTFont(sys.argv[1])
text = "".join(path.read_text() for path in (root / "src").rglob("*") if path.suffix in {".ts", ".tsx"})
text += "".join(chr(codepoint) for codepoint in range(32, 127))
options = subset.Options()
options.flavor = "woff2"
options.name_IDs = ["*"]
options.name_legacy = True
subsetter = subset.Subsetter(options=options)
subsetter.populate(text=text)
subsetter.subset(font)
names = {1: "Focus Pet Hand", 4: "Focus Pet Hand Regular", 6: "FocusPetHand-Regular", 16: "Focus Pet Hand", 17: "Regular"}
for record in font["name"].names:
    if record.nameID in names:
        record.string = names[record.nameID].encode(record.getEncoding())
font.flavor = "woff2"
output = root / "src/assets/fonts/focus-pet-hand.woff2"
font.save(output)
print(f"{output.name}: {output.stat().st_size:,} bytes")
