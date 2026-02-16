import re
from pathlib import Path

file_path = r"d:\Documents\Codes\2026_RCReaderOnline\MEMORY050A.RC0"
content = Path(file_path).read_text(encoding='utf-8', errors='ignore')

mem_tags = re.findall(r'<mem\s+id="[^"]+">', content)
track1_tags = re.findall(r'<TRACK1>', content)
track2_tags = re.findall(r'<TRACK2>', content)

print(f"File: {file_path}")
print(f"Found {len(mem_tags)} <mem> tags.")
print(f"Found {len(track1_tags)} <TRACK1> tags.")
print(f"Found {len(track2_tags)} <TRACK2> tags.")

if len(mem_tags) > 0:
    print("Mem IDs:", [m for m in mem_tags[:5]])
