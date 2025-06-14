import { supabase } from '../lib/supabase';
import { 
  Notification, 
  GlobalNotification, 
  GlobalNotificationRead, 
  TransactionNotification,
  parseNotificationData,
  NotificationTypeInfo,
  NOTIFICATION_TYPES,
  TransactionNotificationData
} from '../lib/notification.types';

// Logger for better debugging
const log = (message: string, data?: any) => {
  console.log(`[NotificationService] ${message}`, data || '');
};

const logError = (message: string, error: any) => {
  console.error(`[NotificationService] ${message}`, error);
};

/**
 * Service for handling notifications
 */
// Cache for notifications to prevent excessive database queries
let notificationCache: Record<string, any> = {};

export const NotificationService = {
  /**
   * Clear the notification cache to ensure fresh data on next fetch
   */
  clearCache(): void {
    notificationCache = {};
    log('Notification cache cleared');
  },
  
  /**
   * Create a notification
   * @param notification The notification to create
   * @returns Promise<{success: boolean, id?: string}> indicating success or failure and the created notification ID
   */
  async createNotification(notification: Omit<Notification, 'id' | 'created_at' | 'updated_at'>): Promise<{success: boolean, id?: string}> {
    try {
      log('Creating notification', notification);
      
      // Determine if this is a global notification or transaction notification
      const isGlobal = notification.source === 'global' || 
        ['pengumuman', 'sistem'].includes(notification.jenis);
      
      const timestamp = new Date().toISOString();
      
      if (isGlobal) {
        // Create global notification
        const { data: globalData, error: globalError } = await supabase
          .from('global_notifikasi')
          .insert({
            judul: notification.judul,
            pesan: notification.pesan,
            jenis: notification.jenis,
            data: notification.data || {},
            created_at: timestamp,
            updated_at: timestamp
          })
          .select('id')
          .single();
        
        if (globalError || !globalData) {
          logError('Error creating global notification', globalError);
          return { success: false };
        }
        
        log(`Created global notification with ID: ${globalData.id}`);
        
        // If anggota_id is provided, create read status for that member
        if (notification.anggota_id) {
          // Create read status for a single member
          const { error: readError } = await supabase
            .from('global_notifikasi_read')
            .insert({
              global_notifikasi_id: globalData.id,
              anggota_id: notification.anggota_id,
              is_read: notification.is_read ?? false,
              created_at: timestamp,
              updated_at: timestamp
            });
            
          if (readError) {
            logError('Error creating notification read status', readError);
            // Continue despite error, the notification was still created
          } else {
            log(`Created read status for member ${notification.anggota_id}`);
          }
        } else if (notification.anggota_ids && Array.isArray(notification.anggota_ids)) {
          // Create read status for multiple members if anggota_ids array is provided
          const readStatusEntries = notification.anggota_ids.map(anggotaId => ({
            global_notifikasi_id: globalData.id,
            anggota_id: anggotaId,
            is_read: notification.is_read ?? false,
            created_at: timestamp,
            updated_at: timestamp
          }));
          
          const { error: batchReadError } = await supabase
            .from('global_notifikasi_read')
            .insert(readStatusEntries);
          
          if (batchReadError) {
            logError('Error creating batch notification read statuses', batchReadError);
            // Continue despite error, the notification was still created
          } else {
            log(`Created read status for ${readStatusEntries.length} members`);
          }
        }
        
        return { success: true, id: globalData.id };
      } else {
        // Create transaction notification
        let transaksiId = notification.transaksi_id;
        
        // If transaksi_id is in the data object, extract it
        if (!transaksiId && notification.data) {
          const data = typeof notification.data === 'string' 
            ? parseNotificationData<TransactionNotificationData>(notification.data)
            : notification.data as TransactionNotificationData;
            
          transaksiId = data?.transaksi_id;
        }
        
        if (!transaksiId) {
          logError('Transaction ID is required for transaction notifications', { notification });
          return { success: false };
        }
        
        const { data: transactionData, error } = await supabase
          .from('transaksi_notifikasi')
          .insert({
            judul: notification.judul,
            pesan: notification.pesan,
            jenis: notification.jenis,
            data: notification.data || {},
            is_read: notification.is_read ?? false,
            transaksi_id: transaksiId,
            created_at: timestamp,
            updated_at: timestamp
          })
          .select('id')
          .single();
        
        if (error) {
          logError('Error creating transaction notification', error);
          return { success: false };
        }
        
        log(`Created transaction notification with ID: ${transactionData?.id}`);
        return { success: true, id: transactionData?.id };
      }
    } catch (error) {
      logError('Error in createNotification', error);
      return { success: false };
    }
  },
  
  /**
   * Get all notifications for a member
   * @param anggotaId ID of the member
   * @param limit Maximum number of notifications to fetch
   * @param forceRefresh Force refresh the cache
   * @returns Array of notifications
   */
  async getNotifications(anggotaId: string, limit: number = 50, forceRefresh: boolean = false): Promise<Notification[]> {
    // Use cache if available and not forcing refresh
    const cacheKey = `notifications-${anggotaId}-${limit}`;
    if (!forceRefresh && notificationCache[cacheKey]) {
      log(`Returning cached notifications for member ${anggotaId}`);
      return notificationCache[cacheKey];
    }
    try {
      let transactionNotifications = [];
      
      // First attempt to use RPC function
      log(`Attempting to fetch transaction notifications for member ${anggotaId} using RPC`);
      const { data: rpcNotifications, error: tnError } = await supabase
        .rpc('get_member_transaction_notifications', { member_id: anggotaId })
        .limit(limit);

      if (tnError) {
        logError('Error fetching transaction notifications via RPC', tnError);
        
        // Fallback: Fetch member's transactions first, then get notifications for those transactions
        log('Falling back to manual query for transaction notifications');
        const { data: memberTransactions, error: mtError } = await supabase
          .from('transaksi')
          .select('id')
          .eq('anggota_id', anggotaId);
          
        if (mtError) {
          logError('Error fetching member transactions', mtError);
        } else if (memberTransactions && memberTransactions.length > 0) {
          const transactionIds = memberTransactions.map(t => t.id);
          log(`Found ${transactionIds.length} transactions for member ${anggotaId}`);
          
          // Fetch transaction notifications filtered by transaction IDs
          const { data: tNotifications, error: tNotifError } = await supabase
            .from('transaksi_notifikasi')
            .select('*')
            .in('transaksi_id', transactionIds)
            .order('created_at', { ascending: false })
            .limit(limit);
            
          if (tNotifError) {
            logError('Error fetching transaction notifications', tNotifError);
          } else {
            transactionNotifications = tNotifications || [];
          }
        } else {
          log(`No transactions found for member ${anggotaId}`);
        }
      } else {
        transactionNotifications = rpcNotifications || [];
      }
      
      log(`Found ${transactionNotifications.length} transaction notifications`);
      
      // Fetch global notifications
      const { data: globalNotifications, error: gnError } = await supabase
        .from('global_notifikasi')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (gnError) {
        logError('Error fetching global notifications', gnError);
      }
      
      log(`Found ${globalNotifications?.length || 0} global notifications`);
      
      // Get read status for global notifications
      const { data: readStatusData, error: rsError } = await supabase
        .from('global_notifikasi_read')
        .select('global_notifikasi_id, is_read')
        .eq('anggota_id', anggotaId);
      
      if (rsError) {
        logError('Error fetching notification read status', rsError);
      }
      
      // Create read status map for quick lookup
      const readStatusMap = new Map<string, boolean>();
      if (readStatusData && readStatusData.length > 0) {
        readStatusData.forEach(item => {
          readStatusMap.set(item.global_notifikasi_id, item.is_read);
        });
      }
      
      // Format transaction notifications
      const formattedTransactionNotifications = transactionNotifications.map(item => ({
        id: item.id,
        judul: item.judul,
        pesan: item.pesan,
        jenis: item.jenis,
        data: item.data || {},
        is_read: item.is_read ?? false,
        created_at: item.created_at,
        updated_at: item.updated_at || item.created_at,
        source: 'transaction' as const,
        transaksi_id: item.transaksi_id,
        anggota_id: anggotaId
      }));
      
      // Format global notifications
      const formattedGlobalNotifications = (globalNotifications || []).map(item => ({
        id: item.id,
        judul: item.judul,
        pesan: item.pesan,
        jenis: item.jenis || 'pengumuman',
        data: item.data || {},
        is_read: readStatusMap.get(item.id) ?? false,
        created_at: item.created_at,
        updated_at: item.updated_at || item.created_at,
        source: 'global' as const,
        global_notifikasi_id: item.id,
        anggota_id: anggotaId
      }));
      
      // Combine, sort by date (newest first), and limit the results
      const allNotifications = [
        ...formattedTransactionNotifications,
        ...formattedGlobalNotifications
      ]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, limit);
        
      // Store in cache
      notificationCache[cacheKey] = allNotifications;
      log(`Cached ${allNotifications.length} notifications for member ${anggotaId}`);

      log(`Returning ${allNotifications.length} total notifications (${formattedTransactionNotifications.length} transaction, ${formattedGlobalNotifications.length} global)`);
      return allNotifications;
    } catch (error) {
      logError('Error in getNotifications', error);
      return [];
    }
  },
  
  /**
   * Get notifications by type
   * @param anggotaId The ID of the member to get notifications for
   * @param type The notification type to filter by
   * @param limit Maximum number of notifications to return
   * @returns Promise<Notification[]> Array of notifications of the specified type
   */
  async getNotificationsByType(anggotaId: string, type: string, limit = 20): Promise<Notification[]> {
    try {
      const isGlobalType = ['pengumuman', 'sistem'].includes(type);
      
      if (isGlobalType) {
        // Get global notifications of this type
        const { data, error } = await supabase
          .from('global_notifikasi')
          .select(`
            id,
            judul,
            pesan,
            jenis,
            data,
            created_at,
            updated_at,
            global_notifikasi_read!left(id, anggota_id, is_read)
          `)
          .eq('jenis', type)
          .order('created_at', { ascending: false })
          .limit(limit);
        
        if (error) {
          logError(`Error fetching ${type} notifications`, error);
          return [];
        }
        
        // Transform to match the Notification interface
        return (data || []).map(item => {
          // Find read status for this member
          const readStatus = item.global_notifikasi_read.find(r => r.anggota_id === anggotaId);
          
          return {
            id: item.id,
            judul: item.judul,
            pesan: item.pesan,
            jenis: item.jenis,
            data: item.data || {},
            created_at: item.created_at,
            updated_at: item.updated_at || item.created_at,
            is_read: readStatus?.is_read ?? false,
            source: 'global',
            global_notifikasi_id: item.id,
            anggota_id: anggotaId
          };
        });
      } else {
        // Get transaction notifications of this type
        const { data, error } = await supabase
          .from('transaksi_notifikasi')
          .select('*')
          .eq('jenis', type)
          .order('created_at', { ascending: false })
          .limit(limit);
        
        if (error) {
          logError(`Error fetching ${type} notifications`, error);
          return [];
        }
        
        // Transform to match the Notification interface
        return (data || []).map(item => ({
          id: item.id,
          judul: item.judul,
          pesan: item.pesan,
          jenis: item.jenis,
          data: item.data || {},
          created_at: item.created_at,
          updated_at: item.updated_at || item.created_at,
          is_read: item.is_read ?? false,
          source: 'transaction',
          transaksi_id: item.transaksi_id,
          anggota_id: anggotaId
        }));
      }
    } catch (error) {
      logError(`Error in getNotificationsByType (${type})`, error);
      return [];
    }
  },
  
  /**
   * Get notification types info
   */
  getNotificationTypeInfo(type: string): NotificationTypeInfo {
    return NOTIFICATION_TYPES[type] || {
      name: 'Lainnya',
      icon: 'notifications-outline',
      color: '#6c757d',
      isPushEnabled: false,
      isGlobal: false
    };
  },
  
  /**
   * Get unread notification count
   * @param anggotaId The ID of the member to get unread count for
   * @returns Promise<number> The count of unread notifications
   */
  async getUnreadCount(anggotaId: string): Promise<number> {
    try {
      log(`Getting unread notification count for anggota ID: ${anggotaId}`);
      
      // Count unread transaction notifications
      const { count: transactionCount, error: transactionError } = await supabase
        .from('transaksi_notifikasi')
        .select('*', { count: 'exact', head: true })
        .eq('is_read', false);
      
      if (transactionError) {
        logError('Error counting unread transaction notifications', transactionError);
        return 0;
      }
      
      // Count unread global notifications
      const { count: globalCount, error: globalError } = await supabase
        .from('global_notifikasi_read')
        .select('*', { count: 'exact', head: true })
        .eq('anggota_id', anggotaId)
        .eq('is_read', false);
      
      if (globalError) {
        logError('Error counting unread global notifications', globalError);
        return transactionCount || 0;
      }
      
      const totalCount = (transactionCount || 0) + (globalCount || 0);
      log(`Found ${totalCount} unread notifications for anggota ID: ${anggotaId}`);
      return totalCount;
    } catch (error) {
      logError('Error in getUnreadCount', error);
      return 0;
    }
  },
  
  /**
   * Mark a notification as read
   * @param notificationId The ID of the notification to mark as read
   * @param source Optional source type to specify which table to update
   * @param anggotaId Optional member ID required for creating global notification read status
   * @returns Promise<boolean> Whether the operation was successful
   */
  async markAsRead(
    notificationId: string, 
    source?: 'global' | 'transaction',
    anggotaId?: string
  ): Promise<boolean> {
    try {
      log(`Marking notification as read: ${notificationId}, source: ${source || 'unknown'}, anggotaId: ${anggotaId || 'not provided'}`);
      
      if (!anggotaId) {
        logError('Cannot mark notification as read: missing anggotaId');
        return false;
      }
      
      // Use the dedicated RPC function to ensure transaction completion and proper read status
      const { data, error } = await supabase.rpc('mark_notification_as_read', {
        p_notification_id: notificationId,
        p_source: source || null, // Send as null if source is undefined
        p_anggota_id: anggotaId
      });
      
      if (error) {
        logError('Error calling mark_notification_as_read RPC', error);
        
        // Fall back to direct table updates if RPC fails
        log('Falling back to direct table updates');
        return this.markAsReadDirectly(notificationId, source, anggotaId);
      }
      
      const success = data === true;
      
      if (success) {
        log(`Successfully marked notification ${notificationId} as read via RPC`);
        // Clear cache to ensure fresh data on next fetch
        this.clearCache();
      } else {
        log(`Failed to mark notification ${notificationId} as read via RPC`);
      }
      
      return success;
    } catch (error) {
      logError('Error in markAsRead', error);
      // Fallback to direct method as last resort
      return this.markAsReadDirectly(notificationId, source, anggotaId);
    }
  },
  
  /**
   * Legacy direct method to mark a notification as read - used as fallback if RPC fails
   */
  async markAsReadDirectly(
    notificationId: string, 
    source?: 'global' | 'transaction',
    anggotaId?: string
  ): Promise<boolean> {
    try {
      log(`Using direct table updates to mark notification as read: ${notificationId}`);
      
      // Try to first fetch the notification to see its actual data
      if (anggotaId) {
        try {
          log(`Fetching notification details for ID: ${notificationId}`);
          // Get the notification data first to determine the correct source
          const { data: rpcResult } = await supabase.rpc('get_member_notifications', {
            p_anggota_id: anggotaId,
            p_limit: 50
          });
          
          const foundNotification = rpcResult?.find(n => n.id === notificationId);
          if (foundNotification) {
            log(`Found notification through RPC: ${JSON.stringify({
              id: foundNotification.id,
              transaksi_id: foundNotification.transaksi_id,
              source_type: foundNotification.source_type
            })}`);
            
            // Update source based on what we found
            if (foundNotification.transaksi_id) {
              source = 'transaction';
            } else {
              source = 'global';
            }
          }
        } catch (rpcError) {
          log(`Error fetching notification via RPC: ${rpcError.message}`);        
        }
      }
      
      // Check transaction notifications
      if (!source || source === 'transaction') {
        // First try by direct ID match
        const { data: checkTransData, error: checkTransError } = await supabase
          .from('transaksi_notifikasi')
          .select('id, transaksi_id')
          .eq('id', notificationId)
          .limit(1);
          
        if (!checkTransError && checkTransData && checkTransData.length > 0) {
          log(`Found notification ${notificationId} in transaksi_notifikasi table`);
          
          // Update transaction notification - explicitly set is_read to true
          const { error: updateError } = await supabase
            .from('transaksi_notifikasi')
            .update({ 
              is_read: true, 
              updated_at: new Date().toISOString() 
            })
            .eq('id', notificationId);
          
          if (updateError) {
            logError('Error marking transaction notification as read', updateError);
            return false;
          }
          
          log(`Successfully marked transaction notification ${notificationId} as read`);
          
          // Clear cache to ensure fresh data on next fetch
          this.clearCache();
          
          return true;
        }
        
        // If not found by id directly, try searching by transaksi_id if notification is part of a transaction
        // (This would require the full notification object or transaksi_id)
        
        if (checkTransError) {
          log(`Error checking transaction notification: ${checkTransError.message}`);
        } else {
          log(`No transaction notification found with ID: ${notificationId}`);
        }
      }
      
      // Check global notifications
      if (!source || source === 'global') {
        // First try to find by direct ID match
        const { data: checkGlobalData, error: checkGlobalError } = await supabase
          .from('global_notifikasi')
          .select('id')
          .eq('id', notificationId)
          .limit(1);
        
        if (!checkGlobalError && checkGlobalData && checkGlobalData.length > 0) {
          log(`Found notification ${notificationId} in global_notifikasi table`);
          
          // If we have anggotaId, we can create/update the read status
          if (anggotaId) {
            // Check if read status record exists
            const { data: readStatusData, error: readStatusError } = await supabase
              .from('global_notifikasi_read')
              .select('id')
              .eq('global_notifikasi_id', notificationId)
              .eq('anggota_id', anggotaId)
              .limit(1);
            
            if (!readStatusError && readStatusData && readStatusData.length > 0) {
              // Update existing read status
              const { error: updateError } = await supabase
                .from('global_notifikasi_read')
                .update({ is_read: true, updated_at: new Date().toISOString() })
                .eq('global_notifikasi_id', notificationId)
                .eq('anggota_id', anggotaId);
              
              if (updateError) {
                logError('Error updating global notification read status', updateError);
                return false;
              }
              
              log(`Updated existing read status for notification ${notificationId}`);
            } else {
              // Create new read status record if it doesn't exist
              const { error: insertError } = await supabase
                .from('global_notifikasi_read')
                .insert({
                  global_notifikasi_id: notificationId,
                  anggota_id: anggotaId,
                  is_read: true,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString()
                });
              
              if (insertError) {
                logError('Error creating global notification read status', insertError);
                return false;
              }
              
              log(`Created new read status for notification ${notificationId}`);
            }
            
            log(`Successfully handled global notification ${notificationId} read status`);
            
            // Clear cache to ensure fresh data on next fetch
            this.clearCache();
            
            return true;
          } else {
            log(`Found global notification but no anggotaId provided to mark as read`);
            // Return false in this case, as we need anggotaId to mark global notifs as read
            return false;
          }
        }
        
        if (checkGlobalError) {
          log(`Error checking global notification: ${checkGlobalError.message}`);
        } else {
          log(`No global notification found with ID: ${notificationId}`);
        }
      }
      
      // If we got here, notification was not found in appropriate tables
      log(`Notification ${notificationId} not found in database tables.`);
      return false;
    } catch (error) {
      logError('Error in markAsReadDirectly', error);
      return false;
    }
  },
  
  /**
   * Mark all notifications as read for a member
   * @param anggotaId The ID of the member to mark all notifications as read for
   * @returns Promise<boolean> Whether the operation was successful
   */
  async markAllAsRead(anggotaId: string): Promise<boolean> {
    try {
      log(`Marking all notifications as read for anggota ID: ${anggotaId}`);
      
      let success = true;
      
      // Mark all transaction notifications as read for this member
      // First get all transactions for this member
      const { data: transactions, error: transQueryError } = await supabase
        .from('transaksi')
        .select('id')
        .eq('anggota_id', anggotaId);
        
      if (transQueryError) {
        logError('Error getting transactions for member', transQueryError);
        success = false;
      } else if (transactions && transactions.length > 0) {
        // Get the transaction IDs for this member
        const transactionIds = transactions.map(t => t.id);
        log(`Found ${transactionIds.length} transactions for member ${anggotaId}`);
        
        // Mark notifications for these transactions as read
        const { error: transactionError } = await supabase
          .from('transaksi_notifikasi')
          .update({ is_read: true, updated_at: new Date().toISOString() })
          .eq('is_read', false)
          .in('transaksi_id', transactionIds);
            
        if (transactionError) {
          logError('Error marking transaction notifications as read', transactionError);
          success = false;
        } else {
          log(`Successfully marked transaction notifications as read for member ${anggotaId}`);
        }
      } else {
        log(`No transactions found for member ${anggotaId}`);
      }
      
      // Note: Transaction notification error handling is now done inside the conditional block above
      
      // Mark all global notifications as read for this member
      const { error: globalError } = await supabase
        .from('global_notifikasi_read')
        .update({ is_read: true, updated_at: new Date().toISOString() })
        .eq('anggota_id', anggotaId)
        .eq('is_read', false);
      
      if (globalError) {
        logError('Error marking all global notifications as read', globalError);
        success = false;
      } else {
        log(`Successfully marked all global notifications as read for anggota ID: ${anggotaId}`);
      }
      
      return success;
    } catch (error) {
      logError('Error in markAllAsRead', error);
      return false;
    }
  }
};