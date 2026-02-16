import re
import os

file_path = r"d:\Documents\Codes\2026_RCReaderOnline\data\MEMORY050A.RC0"

try:
    if not os.path.exists(file_path):
        print(f"Error: File not found at {file_path}")
        # Try relative path
        file_path = "data/MEMORY050A.RC0"
        if not os.path.exists(file_path):
             print(f"Error: File also not found at {file_path}")
             exit(1)

    print(f"Reading file: {file_path}")
    with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()

    mem_tags = re.findall(r'<mem\s+id="[^"]+">', content)
    track_tags = re.findall(r'<TRACK\d+>', content)
    
    print(f"Found {len(mem_tags)} <mem> tags.")
    print(f"Found {len(track_tags)} <TRACKx> tags.")
    
    # Check for unique track names
    unique_tracks = set(track_tags)
    print(f"Unique TRACK tags found: {sorted(list(unique_tracks))}")

    # Check for ICTL tags
    ictl_tags = re.findall(r'<ICTL[^>]+>', content)
    print(f"Found {len(ictl_tags)} ICTL tags.")

except Exception as e:
    print(f"An error occurred: {e}")
