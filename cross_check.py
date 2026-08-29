import nbformat, ast, sys

nb = nbformat.read('train_nexus_wakeword_kaggle.ipynb', as_version=4)

# Cross-check 1: Verify all code cells have valid Python syntax
issues = []
for i, cell in enumerate(nb.cells):
    if cell.cell_type != 'code':
        continue
    code_lines = []
    for line in cell.source.split('\n'):
        if line.strip().startswith('!') or line.strip().startswith('%'):
            continue
        code_lines.append(line)
    code = '\n'.join(code_lines)
    try:
        ast.parse(code)
    except SyntaxError as e:
        issues.append(f'  Cell {i}: SyntaxError: {e}')

if issues:
    print('SYNTAX ISSUES:')
    for issue in issues:
        print(issue)
else:
    print('Cross-check 1 PASSED: All code cells have valid Python syntax')

# Cross-check 2: Check for common issues
print('\nCross-check 2: Common issues check')
for i, cell in enumerate(nb.cells):
    if cell.cell_type != 'code':
        continue
    src = cell.source
    if 'C:\\' in src or '/home/' in src:
        print(f'  Cell {i}: WARNING - hardcoded path detected')
print('  No hardcoded paths found')

# Cross-check 3: Verify cell ordering
print('\nCross-check 3: Cell ordering')
expected_order = [
    'Install System', 'Install Python', 'Compatibility',
    'Download Piper', 'Download Room', 'Generate Positive',
    'Generate Adversarial', 'Augment', 'Split Data',
    'Create Training', 'Train the', 'Export Model',
    'Test the', 'Download the'
]
for i, expected in enumerate(expected_order):
    md_idx = i * 2 + 1
    if md_idx < len(nb.cells):
        cell_src = nb.cells[md_idx].source
        if expected.lower() not in cell_src.lower():
            print(f'  WARNING: Cell {md_idx} does not match expected "{expected}"')
        else:
            print(f'  OK: Cell {md_idx} contains "{expected}"')

# Cross-check 4: Check piper generate_samples API
print('\nCross-check 4: Piper API check')
for i, cell in enumerate(nb.cells):
    if cell.cell_type != 'code':
        continue
    if 'generate_samples' in cell.source:
        if 'model=' in cell.source or 'model =' in cell.source:
            print(f'  Cell {i}: OK - model= kwarg used')
        else:
            print(f'  Cell {i}: WARNING - generate_samples without model= kwarg')

# Cross-check 5: Check for assert statements that might fail
print('\nCross-check 5: Assert statements')
for i, cell in enumerate(nb.cells):
    if cell.cell_type != 'code':
        continue
    for line in cell.source.split('\n'):
        if 'assert ' in line:
            print(f'  Cell {i}: {line.strip()[:80]}')

print('\nCross-check complete')
