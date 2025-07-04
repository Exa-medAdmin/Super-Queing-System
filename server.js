// server.js - Railway Version with Server-Sent Events และระบบการตั้งค่า
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// เก็บ SSE connections
const sseClients = new Set();

// Middleware
app.use(express.json());
app.use(express.static('public'));

// ตรวจสอบและสร้างโฟลเดอร์ data ถ้าไม่มี
if (!fs.existsSync('./data')) {
  fs.mkdirSync('./data');
}

// Database Setup
const db = new sqlite3.Database('./data/queue.db');

// ฟังก์ชันส่งข้อมูลไปยัง SSE clients ทั้งหมด
function broadcastQueueUpdate(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  
  sseClients.forEach(client => {
    try {
      client.write(message);
    } catch (error) {
      // ลบ client ที่ขาดการเชื่อมต่อ
      sseClients.delete(client);
    }
  });
  
  console.log(`📡 Broadcasting to ${sseClients.size} clients`);
}

// ฟังก์ชันดึงข้อมูลการตั้งค่าระบบ
function getSystemSettings() {
  return new Promise((resolve, reject) => {
    const query = `SELECT * FROM system_settings WHERE id = 1`;
    
    db.get(query, (err, settings) => {
      if (err) {
        reject(err);
        return;
      }

      // ถ้าไม่มีการตั้งค่า ให้ใช้ค่า default
      if (!settings) {
        resolve({
          channel_count: 6,
          description_text: '',
          background_theme: 'default'
        });
      } else {
        resolve({
          channel_count: settings.channel_count,
          description_text: settings.description_text || '',
          background_theme: settings.background_theme || 'default'
        });
      }
    });
  });
}

// ฟังก์ชันดึงข้อมูลสถานะคิวปัจจุบัน
function getCurrentQueueStatus() {
  return new Promise(async (resolve, reject) => {
    try {
      // ดึงการตั้งค่าระบบ
      const settings = await getSystemSettings();
      
      const query = `
        SELECT channel_name, current_queue, is_active 
        FROM service_channels 
        ORDER BY channel_name
      `;
      
      db.all(query, (err, channels) => {
        if (err) {
          reject(err);
          return;
        }

        // นับคิวที่รออยู่
        db.get(`SELECT COUNT(*) as waiting FROM queues WHERE status = 'รอ'`, (err, waitingResult) => {
          if (err) {
            reject(err);
            return;
          }

          // ดึงเวลาเรียกคิวของแต่ละคิวที่กำลังให้บริการ
          const queueQuery = `
            SELECT queue_number, called_time 
            FROM queues 
            WHERE status = 'กำลังใช้บริการ' AND called_time IS NOT NULL
          `;

          db.all(queueQuery, (err, queueTimes) => {
            if (err) {
              reject(err);
              return;
            }

            const serviceChannels = {};
            channels.forEach(channel => {
              serviceChannels[channel.channel_name] = {
                currentQueue: channel.current_queue,
                isActive: channel.is_active === 1
              };
            });

            // สร้าง object เก็บเวลาเรียกคิว
            const queueCallTimes = {};
            queueTimes.forEach(item => {
              queueCallTimes[item.queue_number] = item.called_time;
            });

            resolve({
              serviceChannels,
              queueCallTimes,
              waitingQueues: waitingResult.waiting,
              totalQueues: 1500,
              timestamp: new Date().toLocaleString('th-TH'),
              settings: settings
            });
          });
        });
      });
    } catch (error) {
      reject(error);
    }
  });
}

// ฟังก์ชันเริ่มต้น Database
function initializeDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // ตาราง queues - เก็บข้อมูลคิวทั้งหมด
      db.run(`CREATE TABLE IF NOT EXISTS queues (
        id INTEGER PRIMARY KEY,
        queue_number INTEGER UNIQUE,
        status TEXT DEFAULT 'รอ',
        service_channel TEXT,
        called_time TEXT,
        finished_time TEXT
      )`, (err) => {
        if (err) {
          console.error('Error creating queues table:', err);
          reject(err);
          return;
        }
      });

      // ตาราง service_channels - เก็บสถานะช่องบริการ
      db.run(`CREATE TABLE IF NOT EXISTS service_channels (
        id INTEGER PRIMARY KEY,
        channel_name TEXT UNIQUE,
        current_queue INTEGER,
        is_active BOOLEAN DEFAULT FALSE
      )`, (err) => {
        if (err) {
          console.error('Error creating service_channels table:', err);
          reject(err);
          return;
        }
      });

      // ตาราง history - เก็บประวัติการทำงาน
      db.run(`CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_number INTEGER,
        service_channel TEXT,
        action TEXT,
        timestamp TEXT,
        details TEXT
      )`, (err) => {
        if (err) {
          console.error('Error creating history table:', err);
          reject(err);
          return;
        }
      });

      // ตาราง system_settings - เก็บการตั้งค่าระบบ
      db.run(`CREATE TABLE IF NOT EXISTS system_settings (
        id INTEGER PRIMARY KEY,
        channel_count INTEGER DEFAULT 6,
        description_text TEXT DEFAULT '',
        background_theme TEXT DEFAULT 'default',
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err) {
          console.error('Error creating system_settings table:', err);
          reject(err);
          return;
        }
      });

      console.log('✅ Database initialized successfully');
      resolve();
    });
  });
}

// ฟังก์ชันเริ่มต้นช่องบริการตามจำนวนที่ตั้งค่า
async function initializeChannels() {
  return new Promise(async (resolve, reject) => {
    try {
      const settings = await getSystemSettings();
      const channelCount = settings.channel_count;

      // ลบช่องบริการเก่าทั้งหมด
      db.run('DELETE FROM service_channels', (err) => {
        if (err) {
          reject(err);
          return;
        }

        // สร้างช่องบริการใหม่ตามจำนวนที่ตั้งค่า
        const stmt = db.prepare(`INSERT INTO service_channels (channel_name, current_queue, is_active) 
                                VALUES (?, NULL, FALSE)`);
        
        for (let i = 1; i <= channelCount; i++) {
          stmt.run(`ช่องบริการ ${i}`);
        }
        
        stmt.finalize((err) => {
          if (err) {
            reject(err);
            return;
          }
          console.log(`✅ Created ${channelCount} service channels`);
          resolve();
        });
      });
    } catch (error) {
      reject(error);
    }
  });
}

// ฟังก์ชันเริ่มต้นคิว 1-1500
function initializeQueues() {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM queues', (err) => {
      if (err) {
        reject(err);
        return;
      }

      const stmt = db.prepare(`INSERT INTO queues (queue_number, status) VALUES (?, 'รอ')`);
      
      for (let i = 1; i <= 1500; i++) {
        stmt.run(i);
      }
      
      stmt.finalize((err) => {
        if (err) {
          reject(err);
          return;
        }
        console.log('✅ Created queues 1-1500');
        resolve();
      });
    });
  });
}

// ฟังก์ชันเริ่มต้นการตั้งค่าระบบ
function initializeSystemSettings() {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM system_settings WHERE id = 1', (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      if (!row) {
        // สร้างการตั้งค่าเริ่มต้น
        const insertSettings = `
          INSERT INTO system_settings (id, channel_count, description_text, background_theme)
          VALUES (1, 6, '', 'default')
        `;
        
        db.run(insertSettings, (err) => {
          if (err) {
            reject(err);
            return;
          }
          console.log('✅ Created default system settings');
          resolve();
        });
      } else {
        console.log('✅ System settings already exist');
        resolve();
      }
    });
  });
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/display', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

app.get('/control', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'control.html'));
});

// SSE Endpoint สำหรับ real-time updates
app.get('/api/queue-stream', (req, res) => {
  // ตั้งค่า SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // เพิ่ม client ใหม่
  sseClients.add(res);
  console.log(`📱 New SSE client connected. Total: ${sseClients.size}`);

  // ส่งข้อมูลปัจจุบันทันทีให้ client ใหม่
  getCurrentQueueStatus()
    .then(data => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    })
    .catch(error => {
      console.error('Error sending initial SSE data:', error);
    });

  // ส่งข้อความ ping ทุก 30 วินาที เพื่อรักษาการเชื่อมต่อ
  const pingInterval = setInterval(() => {
    try {
      res.write('data: {"type":"ping"}\n\n');
    } catch (error) {
      clearInterval(pingInterval);
      sseClients.delete(res);
    }
  }, 30000);

  // จัดการเมื่อ client ตัดการเชื่อมต่อ
  req.on('close', () => {
    clearInterval(pingInterval);
    sseClients.delete(res);
    console.log(`📱 SSE client disconnected. Total: ${sseClients.size}`);
  });
});

// API: ดูสถานะคิวปัจจุบันทั้งหมด (สำหรับ fallback)
app.get('/api/queue-status', async (req, res) => {
  try {
    const data = await getCurrentQueueStatus();
    res.json(data);
  } catch (error) {
    console.error('Error getting queue status:', error);
    res.status(500).json({ error: 'ไม่สามารถดึงข้อมูลได้' });
  }
});

// API: ดูการตั้งค่าระบบ
app.get('/api/system-settings', async (req, res) => {
  try {
    const settings = await getSystemSettings();
    res.json(settings);
  } catch (error) {
    console.error('Error getting system settings:', error);
    res.status(500).json({ error: 'ไม่สามารถดึงการตั้งค่าได้' });
  }
});

// API: อัปเดตการตั้งค่าระบบ
app.post('/api/system-settings', async (req, res) => {
  const { channelCount, descriptionText, backgroundTheme } = req.body;
  
  // ตรวจสอบข้อมูล
  if (!channelCount || channelCount < 1 || channelCount > 20) {
    return res.status(400).json({ error: 'จำนวนช่องบริการต้องอยู่ระหว่าง 1-20' });
  }

  if (typeof descriptionText !== 'string') {
    return res.status(400).json({ error: 'ข้อความอธิบายไม่ถูกต้อง' });
  }

  if (!['default', 'blue', 'green', 'purple', 'orange', 'red'].includes(backgroundTheme)) {
    return res.status(400).json({ error: 'ธีมสีไม่ถูกต้อง' });
  }

  try {
    // อัปเดตการตั้งค่า
    const updateQuery = `
      UPDATE system_settings 
      SET channel_count = ?, description_text = ?, background_theme = ?, updated_at = datetime('now', 'localtime')
      WHERE id = 1
    `;

    db.run(updateQuery, [channelCount, descriptionText, backgroundTheme], async function(err) {
      if (err) {
        console.error('Error updating system settings:', err);
        return res.status(500).json({ error: 'ไม่สามารถอัปเดตการตั้งค่าได้' });
      }

      // ถ้าจำนวนช่องเปลี่ยน ต้องอัปเดตช่องบริการ
      try {
        await initializeChannels();
        
        // บันทึกประวัติ
        const insertHistory = `
          INSERT INTO history (action, timestamp, details)
          VALUES ('อัปเดตการตั้งค่าระบบ', datetime('now', 'localtime'), ?)
        `;

        db.run(insertHistory, [JSON.stringify({ channelCount, descriptionText, backgroundTheme })], async (err) => {
          if (err) {
            console.error('Error inserting settings history:', err);
          }

          // ส่งข้อมูลอัปเดตไปยัง SSE clients
          try {
            const updatedData = await getCurrentQueueStatus();
            broadcastQueueUpdate(updatedData);
          } catch (error) {
            console.error('Error broadcasting settings update:', error);
          }

          res.json({ 
            success: true, 
            message: 'อัปเดตการตั้งค่าเรียบร้อยแล้ว',
            settings: { channelCount, descriptionText, backgroundTheme }
          });
        });
      } catch (channelError) {
        console.error('Error updating channels:', channelError);
        return res.status(500).json({ error: 'ไม่สามารถอัปเดตช่องบริการได้' });
      }
    });
  } catch (error) {
    console.error('Error updating system settings:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอัปเดตการตั้งค่า' });
  }
});

// API: ดูสถานะคิวของช่องบริการเฉพาะ
app.get('/api/queue-status/:serviceChannel', (req, res) => {
  const serviceChannel = decodeURIComponent(req.params.serviceChannel);
  
  const query = `SELECT current_queue, is_active FROM service_channels WHERE channel_name = ?`;
  
  db.get(query, [serviceChannel], (err, row) => {
    if (err) {
      console.error('Error getting channel status:', err);
      return res.status(500).json({ error: 'ไม่สามารถดึงข้อมูลได้' });
    }

    if (!row) {
      return res.status(404).json({ error: 'ไม่พบช่องบริการที่ระบุ' });
    }

    res.json({
      currentQueue: row.current_queue || 'ว่าง',
      isActive: row.is_active === 1
    });
  });
});

// API: เรียกคิวถัดไป
app.post('/api/call-next-queue', async (req, res) => {
  const { serviceChannel } = req.body;
  
  if (!serviceChannel) {
    return res.status(400).json({ error: 'ไม่ได้ระบุช่องบริการ' });
  }

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    // 1. เปลี่ยนสถานะคิวเก่าให้เป็น "เสร็จสิ้น"
    const updateOldQueue = `
      UPDATE queues 
      SET status = 'เสร็จสิ้น', finished_time = datetime('now', 'localtime')
      WHERE queue_number = (
        SELECT current_queue FROM service_channels WHERE channel_name = ?
      ) AND status = 'กำลังใช้บริการ'
    `;

    db.run(updateOldQueue, [serviceChannel], function(err) {
      if (err) {
        console.error('Error updating old queue:', err);
        db.run('ROLLBACK');
        return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอัปเดตคิวเก่า' });
      }

      // 2. หาคิวรอตัวถัดไป
      const findNextQueue = `
        SELECT queue_number FROM queues 
        WHERE status = 'รอ' 
        ORDER BY queue_number ASC 
        LIMIT 1
      `;

      db.get(findNextQueue, (err, nextQueue) => {
        if (err) {
          console.error('Error finding next queue:', err);
          db.run('ROLLBACK');
          return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการหาคิวถัดไป' });
        }

        if (!nextQueue) {
          // ไม่มีคิวรออยู่
          const updateChannel = `
            UPDATE service_channels 
            SET current_queue = NULL, is_active = FALSE 
            WHERE channel_name = ?
          `;

          db.run(updateChannel, [serviceChannel], async (err) => {
            if (err) {
              console.error('Error updating channel (no queue):', err);
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
            }

            db.run('COMMIT');
            
            // ส่งข้อมูลอัปเดตไปยัง SSE clients
            try {
              const updatedData = await getCurrentQueueStatus();
              broadcastQueueUpdate(updatedData);
            } catch (error) {
              console.error('Error broadcasting update:', error);
            }

            res.json({ 
              success: false, 
              message: 'ไม่มีคิวรออยู่ขณะนี้'
            });
          });
          return;
        }

        // 3. อัปเดตคิวใหม่
        const updateNewQueue = `
          UPDATE queues 
          SET status = 'กำลังใช้บริการ', 
              service_channel = ?, 
              called_time = datetime('now', 'localtime')
          WHERE queue_number = ?
        `;

        db.run(updateNewQueue, [serviceChannel, nextQueue.queue_number], function(err) {
          if (err) {
            console.error('Error updating new queue:', err);
            db.run('ROLLBACK');
            return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอัปเดตคิวใหม่' });
          }

          // 4. อัปเดตช่องบริการ
          const updateChannel = `
            UPDATE service_channels 
            SET current_queue = ?, is_active = TRUE 
            WHERE channel_name = ?
          `;

          db.run(updateChannel, [nextQueue.queue_number, serviceChannel], async (err) => {
            if (err) {
              console.error('Error updating service channel:', err);
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอัปเดตช่องบริการ' });
            }

            // 5. บันทึกประวัติ
            const insertHistory = `
              INSERT INTO history (queue_number, service_channel, action, timestamp, details)
              VALUES (?, ?, 'เรียกคิว', datetime('now', 'localtime'), 'เรียกคิวเข้าให้บริการ')
            `;

            db.run(insertHistory, [nextQueue.queue_number, serviceChannel], async (err) => {
              if (err) {
                console.error('Error inserting history:', err);
                // ไม่ rollback เพราะ history ไม่สำคัญมาก
              }

              db.run('COMMIT');

              // ส่งข้อมูลอัปเดตไปยัง SSE clients
              try {
                const updatedData = await getCurrentQueueStatus();
                broadcastQueueUpdate(updatedData);
              } catch (error) {
                console.error('Error broadcasting update:', error);
              }

              res.json({ 
                success: true, 
                queueNumber: nextQueue.queue_number,
                message: `เรียกคิว ${nextQueue.queue_number} สำหรับ${serviceChannel} เรียบร้อยแล้ว`
              });
            });
          });
        });
      });
    });
  });
});

// API: รีเซ็ตคิวทั้งหมด
app.post('/api/reset-all-queues', async (req, res) => {
  const { confirmationCode } = req.body;
  
  if (confirmationCode !== '12345') {
    return res.status(400).json({ error: 'รหัสยืนยันไม่ถูกต้อง' });
  }

  try {
    await initializeQueues();
    
    // รีเซ็ตช่องบริการทั้งหมด
    db.run(`UPDATE service_channels SET current_queue = NULL, is_active = FALSE`, async (err) => {
      if (err) {
        console.error('Error resetting channels:', err);
        return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการรีเซ็ตช่องบริการ' });
      }

      // บันทึกประวัติ
      const insertHistory = `
        INSERT INTO history (action, timestamp, details)
        VALUES ('รีเซ็ตระบบ', datetime('now', 'localtime'), 'รีเซ็ตคิวทั้งหมด 1-1500')
      `;

      db.run(insertHistory, async (err) => {
        if (err) {
          console.error('Error inserting reset history:', err);
        }

        // ส่งข้อมูลอัปเดตไปยัง SSE clients
        try {
          const updatedData = await getCurrentQueueStatus();
          broadcastQueueUpdate(updatedData);
        } catch (error) {
          console.error('Error broadcasting reset update:', error);
        }

        res.json({ 
          success: true, 
          message: 'รีเซ็ตระบบเรียบร้อยแล้ว สร้างคิว 1-1500 ใหม่' 
        });
      });
    });
  } catch (error) {
    console.error('Error resetting queues:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการรีเซ็ตระบบ' });
  }
});

// API: กู้คืนสถานะระบบ (ทับคิวเก่า)
app.post('/api/restore-queues', async (req, res) => {
  const { channels } = req.body;
  
  if (!channels || typeof channels !== 'object') {
    return res.status(400).json({ error: 'ข้อมูลช่องบริการไม่ถูกต้อง' });
  }

  try {
    // รีเซ็ตระบบก่อน
    await initializeQueues();

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      // รีเซ็ตช่องบริการทั้งหมด
      db.run(`UPDATE service_channels SET current_queue = NULL, is_active = FALSE`, (err) => {
        if (err) {
          console.error('Error resetting channels for restore:', err);
          db.run('ROLLBACK');
          return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการรีเซ็ต' });
        }

        // กู้คืนสถานะตามที่ระบุ
        let processedChannels = 0;
        const channelEntries = Object.entries(channels).filter(([channel, queue]) => queue > 0);
        
        if (channelEntries.length === 0) {
          db.run('COMMIT');
          return res.json({ 
            success: true, 
            message: 'รีเซ็ตระบบเรียบร้อยแล้ว (ไม่มีข้อมูลกู้คืน)'
          });
        }

        channelEntries.forEach(([channelName, queueNumber]) => {
          if (queueNumber >= 1 && queueNumber <= 1500) {
            // อัปเดตคิวที่ระบุให้เป็น "กำลังใช้บริการ"
            const updateQueue = `
              UPDATE queues 
              SET status = 'กำลังใช้บริการ', 
                  service_channel = ?, 
                  called_time = datetime('now', 'localtime')
              WHERE queue_number = ?
            `;

            db.run(updateQueue, [channelName, queueNumber], (err) => {
              if (err) {
                console.error('Error updating restored queue:', err);
                db.run('ROLLBACK');
                return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการกู้คืนคิว' });
              }

              // อัปเดตช่องบริการ
              const updateChannel = `
                UPDATE service_channels 
                SET current_queue = ?, is_active = TRUE 
                WHERE channel_name = ?
              `;

              db.run(updateChannel, [queueNumber, channelName], (err) => {
                if (err) {
                  console.error('Error updating restored channel:', err);
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการกู้คืนช่องบริการ' });
                }

                // ตั้งคิวก่อนหน้าให้เป็น "เสร็จสิ้น"
                const updatePreviousQueues = `
                  UPDATE queues 
                  SET status = 'เสร็จสิ้น', finished_time = datetime('now', 'localtime')
                  WHERE queue_number < ? AND status = 'รอ'
                `;

                db.run(updatePreviousQueues, [queueNumber], async (err) => {
                  if (err) {
                    console.error('Error updating previous queues:', err);
                  }

                  processedChannels++;
                  
                  // เมื่อประมวลผลครบทุกช่องแล้ว
                  if (processedChannels === channelEntries.length) {
                    // บันทึกประวัติ
                    const insertHistory = `
                      INSERT INTO history (action, timestamp, details)
                      VALUES ('กู้คืนสถานะระบบ', datetime('now', 'localtime'), ?)
                    `;

                    db.run(insertHistory, [JSON.stringify(channels)], async (err) => {
                      if (err) {
                        console.error('Error inserting restore history:', err);
                      }

                      db.run('COMMIT');

                      // ส่งข้อมูลอัปเดตไปยัง SSE clients
                      try {
                        const updatedData = await getCurrentQueueStatus();
                        broadcastQueueUpdate(updatedData);
                      } catch (error) {
                        console.error('Error broadcasting restore update:', error);
                      }

                      res.json({ 
                        success: true, 
                        message: 'กู้คืนสถานะระบบเรียบร้อยแล้ว',
                        restoredChannels: channels
                      });
                    });
                  }
                });
              });
            });
          } else {
            processedChannels++;
            
            if (processedChannels === channelEntries.length) {
              db.run('COMMIT');
              res.json({ 
                success: true, 
                message: 'กู้คืนสถานะระบบเรียบร้อยแล้ว',
                restoredChannels: channels
              });
            }
          }
        });
      });
    });
  } catch (error) {
    console.error('Error restoring queues:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการกู้คืนระบบ' });
  }
});

// API: ประวัติการทำงาน
app.get('/api/history', (req, res) => {
  const query = `
    SELECT * FROM history 
    ORDER BY timestamp DESC 
    LIMIT 50
  `;
  
  db.all(query, (err, rows) => {
    if (err) {
      console.error('Error getting history:', err);
      return res.status(500).json({ error: 'ไม่สามารถดึงประวัติได้' });
    }
    
    res.json(rows);
  });
});

// API: สถิติระบบ
app.get('/api/statistics', (req, res) => {
  const queries = {
    completed: `SELECT COUNT(*) as count FROM queues WHERE status = 'เสร็จสิ้น'`,
    inProgress: `SELECT COUNT(*) as count FROM queues WHERE status = 'กำลังใช้บริการ'`,
    waiting: `SELECT COUNT(*) as count FROM queues WHERE status = 'รอ'`,
    activeChannels: `SELECT COUNT(*) as count FROM service_channels WHERE is_active = TRUE`
  };

  let results = {};
  let completed = 0;
  const total = Object.keys(queries).length;

  Object.entries(queries).forEach(([key, query]) => {
    db.get(query, (err, row) => {
      if (err) {
        console.error(`Error getting ${key} statistics:`, err);
        results[key] = 0;
      } else {
        results[key] = row.count;
      }

      completed++;
      
      if (completed === total) {
        res.json({
          totalQueues: 1500,
          completed: results.completed,
          inProgress: results.inProgress,
          waiting: results.waiting,
          activeChannels: results.activeChannels,
          lastUpdate: new Date().toLocaleString('th-TH')
        });
      }
    });
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' });
});

// Initialize and start server
async function startServer() {
  try {
    await initializeDatabase();
    await initializeSystemSettings();
    
    // ตรวจสอบว่ามีคิวในฐานข้อมูลหรือไม่
    db.get('SELECT COUNT(*) as count FROM queues', async (err, row) => {
      if (err) {
        console.error('Error checking queues:', err);
        return;
      }

      if (row.count === 0) {
        console.log('🔄 No queues found, initializing...');
        await initializeQueues();
      } else {
        console.log(`📊 Found ${row.count} queues in database`);
      }

      // เริ่มต้นช่องบริการตามการตั้งค่า
      await initializeChannels();

      app.listen(port, () => {
        console.log(`🚀 Queue System is running on port ${port}`);
        console.log(`📊 Display: http://localhost:${port}/display`);
        console.log(`🎛️ Control: http://localhost:${port}/control`);
        console.log(`⚙️ Admin: http://localhost:${port}/`);
        console.log(`📡 SSE Stream: http://localhost:${port}/api/queue-stream`);
      });
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🔄 Shutting down gracefully...');
  
  // ปิด SSE connections
  sseClients.forEach(client => {
    try {
      client.end();
    } catch (error) {
      // ignore errors during shutdown
    }
  });
  sseClients.clear();
  
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err);
    } else {
      console.log('✅ Database connection closed');
    }
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('🔄 Received SIGTERM, shutting down...');
  
  sseClients.forEach(client => {
    try {
      client.end();
    } catch (error) {
      // ignore errors during shutdown
    }
  });
  sseClients.clear();
  
  db.close(() => {
    process.exit(0);
  });
});

startServer();