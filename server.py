#!/usr/bin/env python3
"""Local server for Peptide Tracker.

Serves the static app files and persists app state to data.json in this same
folder, so your data is a real file on disk instead of living only in the
browser's local storage. It also writes exported label PNGs straight to a folder
of your choosing (POST /api/labels), which is the only way to get them out of
~/Downloads in browsers with no File System Access API. No third-party
dependencies — standard library only.

Run: python3 server.py
Then open the printed http://localhost:PORT address (or use start.command).
"""
import base64
import binascii
import http.server
import json
import os

PORT = 8765
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(BASE_DIR, 'data.json')


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Static files have no version query strings, so without this the
        # browser can serve a stale app.js/styles.css after an edit until a
        # hard refresh. no-cache still allows conditional (304) revalidation.
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_GET(self):
        if self.path == '/api/data':
            self._send_data()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path not in ('/api/data', '/api/labels'):
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return
        if self.path == '/api/labels':
            self._save_labels(parsed)
            return
        tmp_path = DATA_FILE + '.tmp'
        with open(tmp_path, 'w') as f:
            json.dump(parsed, f, indent=2)
        os.replace(tmp_path, DATA_FILE)
        self._send_json({'ok': True})

    def _save_labels(self, payload):
        """Write base64 PNGs to a folder on disk.

        Safari and Firefox have no showDirectoryPicker(), so the browser alone
        can't put an export anywhere but the downloads folder. Since this server
        is already running locally for the same user, it does the writing.

        Filenames are reduced to a bare basename and must end in .png, so a
        payload can only ever create label files inside the folder it names --
        it can't traverse out of it or overwrite arbitrary files.
        """
        raw_dir = (payload.get('dir') or '').strip()
        files = payload.get('files') or []
        if not raw_dir:
            self._send_json({'error': 'No folder given.'}, status=400)
            return
        target = os.path.abspath(os.path.expanduser(raw_dir))
        try:
            os.makedirs(target, exist_ok=True)
        except OSError as e:
            self._send_json({'error': f'Could not create {target}: {e.strerror}'}, status=400)
            return

        saved = []
        for item in files:
            name = os.path.basename((item.get('name') or '').strip())
            if not name or not name.lower().endswith('.png'):
                self._send_json({'error': f'Refusing to write {name!r} -- not a .png filename.'}, status=400)
                return
            try:
                data = base64.b64decode(item.get('data') or '', validate=True)
            except (binascii.Error, ValueError):
                self._send_json({'error': f'{name} was not valid base64.'}, status=400)
                return
            path = os.path.join(target, name)
            tmp_path = path + '.tmp'
            try:
                with open(tmp_path, 'wb') as f:
                    f.write(data)
                os.replace(tmp_path, path)
            except OSError as e:
                self._send_json({'error': f'Could not write {name}: {e.strerror}'}, status=400)
                return
            saved.append(name)
        self._send_json({'saved': len(saved), 'dir': target, 'files': saved})

    def _send_data(self):
        if os.path.exists(DATA_FILE):
            with open(DATA_FILE, 'rb') as f:
                body = f.read()
        else:
            body = b'null'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass  # keep the terminal quiet; this runs locally for one household


if __name__ == '__main__':
    os.chdir(BASE_DIR)
    server = http.server.HTTPServer(('127.0.0.1', PORT), Handler)
    print(f'Peptide Tracker running at http://localhost:{PORT}')
    print(f'Data is saved to {DATA_FILE}')
    print('Press Ctrl+C to stop.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
