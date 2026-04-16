Deploy Render cho app `tiktok/`

1. Push riêng thư mục này lên repo.
2. Trên Render, tạo `Blueprint` hoặc `Web Service` kiểu Docker.
3. Nếu dùng `Blueprint`, trỏ root repo vào thư mục chứa file `tiktok/render.yaml`.
4. Nếu tạo tay:
   - Environment: `Docker`
   - Dockerfile Path: `tiktok/Dockerfile`
   - Health Check Path: `/healthz`
5. Sau khi deploy xong, mở domain Render và dùng trực tiếp.

Lưu ý:
- File tải xuống chỉ sống tạm trong filesystem của instance.
- Restart/redeploy sẽ mất job đang chạy và file zip chưa tải.
- Kênh nhiều video cần RAM/CPU cao hơn, nên tránh plan free.
