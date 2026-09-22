# clipweb：静态网页 + API 反代，单容器收口
# 宿主机上的 SyncClipboard 服务端须监听 127.0.0.1:5033
# （clipweb 容器用 host 网络，127.0.0.1 即宿主机）
FROM nginx:alpine

# html/：index.html、app.js、seed.html、dev/ 静态自检页
COPY html/ /usr/share/nginx/html/

# 自定义 server 块：/ 出静态页（只认 GET/HEAD，WebDAV 动词转给后端），
# 其余全部反代到 127.0.0.1:5033
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 5034

CMD ["nginx", "-g", "daemon off;"]
