import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

console.log('Her 渲染进程已启动')
console.log('环境信息:', {
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  language: navigator.language
})

createRoot(document.getElementById('root')!).render(<App />)
