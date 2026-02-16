from pypdf import PdfReader
import os

pdf_path = "RC-505mkII 用户手册.pdf"
output_path = "manual_dump.txt"

if not os.path.exists(pdf_path):
    print(f"Error: {pdf_path} not found.")
    exit(1)

try:
    reader = PdfReader(pdf_path)
    with open(output_path, "w", encoding="utf-8") as f:
        for i, page in enumerate(reader.pages):
            f.write(f"\n--- Page {i+1} ---\n")
            text = page.extract_text()
            if text:
                f.write(text)
    print(f"Successfully extracted text to {output_path}")
except Exception as e:
    print(f"Error extracting text: {e}")
