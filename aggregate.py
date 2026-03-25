import os
import concurrent.futures
import time

# ================= 配置区域 =================

# 1. 目录黑名单：只要包含这些名字的文件夹，其下所有内容直接跳过
IGNORE_DIRS = {
    # 核心构建与缓存 (Flutter/Dart/Mobile)
    '.dart_tool',   # [重灾区] 包含大量构建缓存
    '.gradle',      # [重灾区] Android构建缓存
    'build',        # 构建产物
    'Pods',         # iOS 依赖
    'ios',          # (可选) 如果只看Dart逻辑，建议连原生层都屏蔽，根据需要注释掉此行
    'android',      # (同上)
    'web',          # (同上)
    'linux', 'windows', 'macos', # 桌面端平台目录

    # 通用/IDE/版本控制
    '.git', '.github', '.idea', '.vscode', 
    '__pycache__', 'node_modules', '.venv', 'venv', 'env',
    '.DS_Store', 'dist', 'obsidian', 'coverage',

    # 浏览器及应用环境数据缓存 (避免采集庞大的沙盒或浏览器配置)
    'appdata', 'AppData', 'User Data', 'Extensions', 'Cache', 
    'GPUCache', 'Code Cache', 'component_crx_cache', 'Crashpad',
    'Default', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Session Storage',
    'Local Storage', 'Network', 'Service Worker', 'shared_proto_db',
    'Segmentation Platform', 'Feature Engagement Tracker', 'GCM Store',
    'BrowserMetrics', 'CertificateRevocation', 'Crowd Deny', 'cfs',
    
    # 构建临时、运行日志及代理层产生的大型目录
    'browser-profile', 'temp', 'jiti', 'node-compile-cache', 
    'sessions', 'logs', 'Microsoft', 'cache'
}

# 2. 文件黑名单：特定的无用文件
IGNORE_FILES = {
    '.DS_Store', 'thumbs.db', 
    'pubspec.lock', 'Podfile.lock', 'yarn.lock', 'package-lock.json', # 锁文件通常不仅浪费token还没用
    'gradlew', 'gradlew.bat', 'local.properties'
}

# 3. 扩展名黑名单：过滤非代码文件
IGNORE_EXTENSIONS = {
    # 图片/媒体
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.mp3', '.mp4',
    # 二进制/编译产物
    '.so', '.dll', '.exe', '.class', '.o', '.a', '.apk', '.jar',
    # 日志/临时/其他/内部数据环境缓存
    '.log', '.cache', '.temp', '.tmp', '.zip', '.tar', '.gz',
    '.bak', '.jsonl', '.pma', '.store', '.bdic', '.db', '.db-journal', '.wal',
    # 特定忽略的文件后缀 (如编译后的动态 cjs 等)
    '.cjs'
}

# ===========================================

def should_ignore(name):
    """判断文件或目录名是否在黑名单中"""
    return name in IGNORE_DIRS or name in IGNORE_FILES

def is_text_file(filename):
    """通过扩展名简单判断是否为需要读取的文本文件"""
    if '.' not in filename:
        return True
    ext = os.path.splitext(filename)[1].lower()
    return ext not in IGNORE_EXTENSIONS

def generate_tree(root_dir, current_dir, prefix=""):
    """递归生成项目目录结构树 (带过滤)"""
    tree_str = ""
    try:
        items = sorted(os.listdir(current_dir))
    except PermissionError:
        return ""

    items = [i for i in items if not should_ignore(i)]
    
    for i, item in enumerate(items):
        path = os.path.join(current_dir, item)
        is_last = (i == len(items) - 1)
        connector = "└── " if is_last else "├── "
        
        tree_str += f"{prefix}{connector}{item}\n"
        
        if os.path.isdir(path):
            extension_prefix = "    " if is_last else "│   "
            tree_str += generate_tree(root_dir, path, prefix + extension_prefix)
    return tree_str

def process_file_content(args):
    """
    线程工作函数：读取并格式化单个文件内容
    返回字典: {'status': 'ok'|'skip'|'error', 'log': str, 'content': str}
    """
    root, file, current_dir = args
    file_path = os.path.join(root, file)
    relative_path = os.path.relpath(file_path, current_dir)
    
    result = {'status': 'error', 'log': '', 'content': ''}

    try:
        # 预先检查文件大小（避免读取后再判断）
        file_size = os.path.getsize(file_path)
        if file_size > 1024 * 1024:
            result['status'] = 'skip'
            result['log'] = f"[SKIPPED] File too large (>1MB): {relative_path}"
            return result

        with open(file_path, 'r', encoding='utf-8') as infile:
            content = infile.read()
            
            ext = os.path.splitext(file)[1][1:] or "text"
            formatted_content = (
                f"## File: {relative_path}\n"
                f"```{ext}\n"
                f"{content}"
                f"\n```\n\n---\n"
            )
            
            result['status'] = 'ok'
            result['log'] = f"[SUCCESS] Aggregated: {relative_path}"
            result['content'] = formatted_content
            
    except UnicodeDecodeError:
        result['status'] = 'skip'
        result['log'] = f"[SKIPPED] Binary/Non-utf8: {relative_path}"
    except PermissionError:
        result['status'] = 'skip'
        result['log'] = f"[SKIPPED] Permission denied: {relative_path}"
    except Exception as e:
        result['status'] = 'error'
        result['log'] = f"[ERROR] {relative_path}: {str(e)}"

    return result

def aggregate_project():
    start_time = time.time()  # 记录开始时间
    
    current_dir = os.path.dirname(os.path.abspath(__file__))
    folder_name = os.path.basename(current_dir)
    output_filename = f"{folder_name}_code_only.md"
    output_path = os.path.join(current_dir, output_filename)

    print(f"[*] 开始扫描项目: {folder_name}")
    print(f"[*] 已启用强力过滤模式 (忽略 .dart_tool, .gradle 等)")
    print(f"[*] 已启用多线程加速处理...")

    # 1. 收集任务与统计 (主线程)
    file_tasks = []
    total_dirs_scanned = 0
    total_files_scanned = 0
    
    # 先生成目录树结构字符串
    tree_content = ""
    try:
        tree_content = generate_tree(current_dir, current_dir)
    except Exception as e:
        print(f"[!] Tree generation failed: {e}")

    # 遍历收集文件
    for root, dirs, files in os.walk(current_dir):
        # 核心逻辑：原地修改 dirs 列表
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        
        total_dirs_scanned += 1          # 统计进入的文件夹数
        total_files_scanned += len(files) # 统计看到的所有文件数
        
        for file in sorted(files):
            # 过滤文件名和扩展名
            if file == os.path.basename(__file__) or file == output_filename or should_ignore(file):
                continue
            
            if not is_text_file(file):
                continue
            
            # 将任务参数打包
            file_tasks.append((root, file, current_dir))

    target_files_count = len(file_tasks)
    
    # 2. 多线程并行读取 (Worker Threads)
    max_workers = min(32, (os.cpu_count() or 1) * 5)
    processed_results = []
    
    print(f"[*] 扫描完成。发现 {total_dirs_scanned} 个文件夹，共 {total_files_scanned} 个文件。")
    print(f"[*] 准备处理 {target_files_count} 个核心代码文件，正在并行读取...")
    
    # 使用线程池处理
    if target_files_count > 0:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            # 使用 map 保证结果顺序
            results = executor.map(process_file_content, file_tasks)
            processed_results = list(results)
    else:
        print("[!] 未找到符合条件的代码文件。")

    # 3. 统一写入文件 (主线程)
    success_count = 0
    with open(output_path, 'w', encoding='utf-8') as outfile:
        # 写入头部
        outfile.write(f"# Project Architecture: {folder_name}\n\n")
        outfile.write("## Directory Tree (Filtered)\n```text\n")
        outfile.write(f"{folder_name}/\n")
        outfile.write(tree_content)
        outfile.write("```\n\n---\n\n")

        # 写入文件内容
        for res in processed_results:
            if res['log']:
                print(res['log']) # 实时打印处理日志
            
            if res['status'] == 'ok':
                outfile.write(res['content'])
                success_count += 1

    end_time = time.time()  # 记录结束时间
    duration = end_time - start_time
    
    # 4. 打印最终统计面板
    print("\n" + "="*40)
    print(f"   [DONE] 项目聚合完成")
    print("="*40)
    print(f" 📂 扫描目录数  : {total_dirs_scanned}")
    print(f" 📑 扫描文件总数: {total_files_scanned}")
    print(f" 🎯 目标代码文件: {target_files_count}")
    print(f" ✅ 成功聚合文件: {success_count}")
    print(f" ⏱️ 总耗时      : {duration:.2f} 秒")
    print(f" 💾 输出文件    : {output_filename}")
    print("="*40 + "\n")

if __name__ == "__main__":
    aggregate_project()