"""Minimal .xlsx reader (stdlib only) for the dubbing script workbook.

The workbook layout is: column A = start timecode, B = end timecode,
C = Arabic narration (blank for on-camera / original-audio cues), D = notes.
"""

import re
import zipfile
import xml.etree.ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_COL = re.compile(r"([A-Z]+)(\d+)")


def _text_of(node):
    return "".join(t.text or "" for t in node.iter(NS + "t"))


def read_sheet(path, sheet="xl/worksheets/sheet1.xml"):
    """Yield {column_letter: value} dicts, one per row, in document order."""
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            shared = [_text_of(si) for si in root.findall(NS + "si")]
        sheet_root = ET.fromstring(z.read(sheet))

    for row in sheet_root.iter(NS + "row"):
        out = {"_row": int(row.get("r") or 0)}
        for c in row.findall(NS + "c"):
            ref = c.get("r") or ""
            m = _COL.match(ref)
            if not m:
                continue
            col = m.group(1)
            t = c.get("t")
            v = c.find(NS + "v")
            if v is None:
                inline = c.find(NS + "is")
                val = _text_of(inline) if inline is not None else ""
            elif t == "s":
                val = shared[int(v.text)]
            else:
                val = v.text or ""
            if val:
                out[col] = val.strip()
        yield out
