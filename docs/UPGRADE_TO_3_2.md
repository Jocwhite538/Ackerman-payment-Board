# Upgrade an Existing IIS Test Site to Version 3.2

1. Build Version 3.2 with `Build\Build-IIS-Drop.cmd`.
2. Stop the **Ackerman Payment Board** IIS site and the `AckermanPaymentBoard` application pool.
3. Back up `C:\inetpub\AckermanPaymentBoard\IIS_SITE_OUTPUT\App_Data`.
4. Replace the old published application files with the new Version 3.2 `IIS_SITE_OUTPUT`.
5. Restore/preserve the prior `App_Data` folder so existing user accounts and non-demo data remain.
6. Grant `IIS AppPool\AckermanPaymentBoard` **Modify** permission on `App_Data`.
7. Confirm the application pool uses **No Managed Code**, Maximum Worker Processes = 1, and Disable Overlapped Recycle = True.
8. Start the application pool and site.
9. Sign in and open the Payment Board. Version 3.2 automatically removes legacy `demo-*` / `DEMO-*` patient records from shared board state.
10. Confirm User Management still shows the existing Super User / Standard User accounts.

Do not delete the database file merely to remove demo patients; Version 3.2 cleans the demo patient records while preserving user accounts.
