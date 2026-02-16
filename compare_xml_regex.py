import re
import os
from collections import defaultdict

file_path = r"d:\Documents\Codes\2026_RCReaderOnline\data\MEMORY050A.RC0"

def parse_content_to_dict(content_str):
    """
    Parses the inner content of a tag into a dictionary.
    Assumes format: <A>15</A> <B>0</B> ...
    """
    # Find all simple tags: <KEY>VALUE</KEY>
    pattern = r'<([A-Z0-9_]+)>(.*?)</\1>'
    matches = re.findall(pattern, content_str, re.DOTALL)
    return {k: v.strip() for k, v in matches}

def compare_tracks(track_contents):
    print("--- Comparing TRACK contents ---")
    
    if not track_contents:
        print("No TRACK elements found.")
        return

    # Check which tracks exist
    available_tracks = sorted(track_contents.keys())
    print(f"Found tracks: {available_tracks}")

    if "TRACK1" not in track_contents:
         print("TRACK1 not found, cannot use as base for comparison.")
         return

    base_name = "TRACK1"
    base_data = track_contents[base_name]

    all_identical = True
    for tag_name in available_tracks:
        if tag_name == base_name:
            continue
        
        current_data = track_contents[tag_name]
        
        diffs = []
        all_keys = set(base_data.keys()) | set(current_data.keys())
        
        for key in sorted(all_keys):
            val1 = base_data.get(key, "<MISSING>")
            val2 = current_data.get(key, "<MISSING>")
            if val1 != val2:
                diffs.append(f"{key}: {val1} vs {val2}")
        
        if diffs:
            all_identical = False
            print(f"\nDifferences in {tag_name} (compared to {base_name}):")
            for d in diffs:
                print(f"  {d}")
        else:
            print(f"{tag_name} is identical to {base_name}")
            
    if all_identical:
        print("\nResult: All TRACKs are identical.")

def compare_effects(all_tags_content):
    print("\n--- Comparing Effect Parameters ---")
    
    # Group tags by pattern: PREFIX_TRACKn_SUFFIX
    groups = defaultdict(dict)
    
    # Also handle things like ICTL1_PEDAL1... which don't have "TRACKn"
    # Maybe group by the prefix before the last number? 
    # The prompt explicitly asked to "compare each effect's parameter settings".
    # Let's look for tags that look like arrays/structs and group them by similarity.
    # A good heuristic is: if we replace numbers with 'N', do they look the same?
    # e.g., ICTL1_TRACK1_FX -> ICTL1_TRACKN_FX. Comparison group is across N.
    
    # Let's stick to the specific request: compare settings.
    # We will group by "Structure Name Template".
    # ICTL1_TRACK1_FX and ICTL1_TRACK2_FX share template ICTL1_TRACK{x}_FX
    
    for tag, content_dict in all_tags_content.items():
        # Try to find a logical grouping
        # Case 1: TRACKx 
        if "TRACK" in tag and "_TRACK" in tag: 
            # ICTL1_TRACK1_FX -> Group by ICTL1_TRACK{}_FX
            # Regex to generalize the TRACK number
            group_key = re.sub(r'TRACK\d+', 'TRACKx', tag)
            groups[group_key][tag] = content_dict
        elif "PEDAL" in tag:
            # ICTL1_PEDAL1 -> ICTL1_PEDALx
            group_key = re.sub(r'PEDAL\d+', 'PEDALx', tag)
            groups[group_key][tag] = content_dict
            
    for group_key, items in sorted(groups.items()):
        sorted_tags = sorted(items.keys())
        if len(sorted_tags) < 2:
            continue
            
        print(f"\nChecking Group: {group_key} (Count: {len(sorted_tags)})")
        base_tag = sorted_tags[0]
        base_data = items[base_tag]
        
        group_match = True
        for tag in sorted_tags[1:]:
            current_data = items[tag]
            diffs = []
            all_keys = set(base_data.keys()) | set(current_data.keys())
            
            for key in sorted(all_keys):
                val1 = base_data.get(key, "<MISSING>")
                val2 = current_data.get(key, "<MISSING>")
                if val1 != val2:
                    diffs.append(f"{key}: {val1} vs {val2}")
            
            if diffs:
                group_match = False
                print(f"  Differences in {tag} (compared to {base_tag}):")
                for d in diffs:
                    print(f"    {d}")
        
        if group_match:
            print(f"  All elements in group are identical.")

def main():
    if not os.path.exists(file_path):
        print(f"Error: File not found at {file_path}")
        return

    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()

        # Regex to find all top-level tags inside <mem> if possible, or just all tags that look like structs
        # The file has <TRACK1>...</TRACK1>, <ICTL1_TRACK1_FX>...</...>, etc.
        # We can just find all tags that contain <A> inside them?
        # Or just find all tags that are capitalized and have nested children.
        
        # Strategy: Find valid XML-like blocks
        # <TAG_NAME> ... content ... </TAG_NAME>
        
        # Since tags are nested (e.g. database -> mem -> TRACK1), valid parsing is hard with simple regex.
        # But we know TRACK1 and ICTL are likely identifying blocks.
        
        # specific targets
        track_pattern = r'<(TRACK\d+)>(.*?)</\1>'
        track_matches = re.findall(track_pattern, content, re.DOTALL)
        track_contents = {tag: parse_content_to_dict(inner) for tag, inner in track_matches}
        
        compare_tracks(track_contents)
        
        # Effect targets (ICTL, ECTL, ASSIGN, etc.)
        # Let's find anything starting with ICTL, ECTL, EQ, ASSIGN
        effect_pattern = r'<((?:ICTL|ECTL|EQ|ASSIGN)[^>]+)>(.*?)</\1>'
        effect_matches = re.findall(effect_pattern, content, re.DOTALL)
        effect_contents = {tag: parse_content_to_dict(inner) for tag, inner in effect_matches}
        
        compare_effects(effect_contents)
        
    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    main()
