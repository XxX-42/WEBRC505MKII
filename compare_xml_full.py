import re
import os
import xml.etree.ElementTree as ET
from collections import defaultdict

file_path = r"d:\Documents\Codes\2026_RCReaderOnline\data\MEMORY050A.RC0"

def parse_element_to_dict(element):
    return {child.tag: child.text for child in element}

def compare_tracks(root):
    print("--- Comparing TRACK contents ---")
    tracks = {}
    for i in range(1, 7):
        tag = f"TRACK{i}"
        node = root.find(tag)
        if node is not None:
            tracks[tag] = parse_element_to_dict(node)
    
    if not tracks:
        print("No TRACK elements found.")
        return

    base_track_name = "TRACK1"
    base_content = tracks.get(base_track_name)
    
    if not base_content:
         print(f"{base_track_name} not found, cannot compare.")
         return

    all_match = True
    for tag_name, content in tracks.items():
        if tag_name == base_track_name:
            continue
        
        diffs = []
        all_keys = set(base_content.keys()) | set(content.keys())
        for key in all_keys:
            val1 = base_content.get(key)
            val2 = content.get(key)
            if val1 != val2:
                diffs.append(f"{key}: {val1} vs {val2}")
        
        if diffs:
            all_match = False
            print(f"Differences found in {tag_name} (compared to {base_track_name}):")
            for d in diffs:
                print(f"  {d}")
        else:
            print(f"{tag_name} is identical to {base_track_name}")
            
    if all_match:
        print("All TRACKs are identical.")

def compare_effects(root):
    print("\n--- Comparing Effect Parameters ---")
    # Group tags by pattern: PREFIX_TRACKn_SUFFIX
    # Example: ICTL1_TRACK1_FX -> Group: ICTL1_..._FX
    
    groups = defaultdict(dict)
    
    for child in root:
        tag = child.tag
        # Regex to match tags containing TRACKn
        match = re.match(r'(.*)TRACK(\d+)(.*)', tag)
        if match:
            prefix, track_num, suffix = match.groups()
            group_key = f"{prefix}TRACKx{suffix}"
            groups[group_key][tag] = parse_element_to_dict(child)
    
    for group_key, items in groups.items():
        print(f"\nChecking Group: {group_key}")
        sorted_tags = sorted(items.keys())
        if not sorted_tags:
            continue
            
        base_tag = sorted_tags[0]
        base_content = items[base_tag]
        
        group_match = True
        for tag in sorted_tags[1:]:
            content = items[tag]
            diffs = []
            all_keys = set(base_content.keys()) | set(content.keys())
            
            for key in all_keys:
                val1 = base_content.get(key)
                val2 = content.get(key)
                if val1 != val2:
                    diffs.append(f"{key}: {val1} vs {val2}")
            
            if diffs:
                group_match = False
                print(f"  Differences in {tag} (compared to {base_tag}):")
                for d in diffs:
                    print(f"    {d}")
        
        if group_match:
            print(f"  All elements in {group_key} are identical.")

def main():
    if not os.path.exists(file_path):
        print(f"Error: File not found at {file_path}")
        return

    try:
        # The file might have multiple top-level elements or not be a standard single-root XML
        # Based on previous view, it has <database> as root? Let's check.
        # The file content showed:
        # <database ...>
        # <mem ...>
        # So it seems <database> is root. 
        # But we are interested in children of <mem> if that's where TRACKs are.
        
        tree = ET.parse(file_path)
        root = tree.getroot()
        
        # Check if we are at database level
        if root.tag == 'database':
            # We likely want to process children of <mem>
            # There is one <mem>, let's get it.
            mem = root.find('mem')
            if mem is not None:
                print("Processing <mem> block...")
                compare_tracks(mem)
                compare_effects(mem)
            else:
                print("No <mem> block found in root.")
                # Fallback: maybe the structure is different, check root directly
                compare_tracks(root)
                compare_effects(root)
        else:
             compare_tracks(root)
             compare_effects(root)

    except Exception as e:
        print(f"Failed to parse or process XML: {e}")
        # Fallback to manual parsing if ET fails (e.g. strict XML issues)

if __name__ == "__main__":
    main()
