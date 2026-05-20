import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function frontendErrorLogger() {
  return {
    name: 'frontend-error-logger',
    configureServer(server) {
      server.middlewares.use('/__frontend_error', (req, res) => {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          try {
            const { message, source, line, col, stack } = JSON.parse(body)
            console.error('\n\x1b[31m[Frontend Error]\x1b[0m', message)
            if (source) console.error('  at', `${source}:${line}:${col}`)
            if (stack) console.error(stack)
          } catch {}
          res.writeHead(204).end()
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), frontendErrorLogger()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
        changeOrigin: true,
      },
      '/report-files': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
