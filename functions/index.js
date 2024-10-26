const functions = require('firebase-functions')
const admin = require('firebase-admin')
const sgMail = require('@sendgrid/mail')
const { Storage } = require('@google-cloud/storage')
const { jsPDF } = require('jspdf')
require('jspdf-autotable')
const path = require('path')
const os = require('os')
const fs = require('fs')
const axios = require('axios')

admin.initializeApp()
sgMail.setApiKey(process.env.SENDGRID_KEY)

const storage = new Storage()

// Función para enviar el correo con detalles del pedido en formato PDF
exports.sendOrderEmail = functions.database
  .ref('/orders-send/{userId}/{orderId}')
  .onCreate(async (snapshot, context) => {
    let pdfPath
    try {
      const order = snapshot.val()
      const userId = context.params.userId
      const orderId = context.params.orderId
      const orderNumber = orderId.substring(0, 5)

      const snapshotUser = await admin
        .database()
        .ref(`/users/${userId}`)
        .once('value')
      const user = snapshotUser.val()

      if (!user || !user.fullName || !user.email) {
        console.error('Error: Datos del usuario incompletos o faltantes.')
        return
      }

      if (!order || !order.items || !Array.isArray(order.items)) {
        console.error('Error: Datos del pedido incompletos o faltantes.')
        return
      }

      // Descargar y preparar la imagen del logo
      const logoUrl =
        'https://sorpresasmagicodia.com/wp-content/uploads/2024/06/MAMBO_APP_2024.png'
      const response = await axios.get(logoUrl, { responseType: 'arraybuffer' })
      const logoData = Buffer.from(response.data, 'binary').toString('base64')

      const doc = new jsPDF()
      const pageWidth = doc.internal.pageSize.getWidth()

      const logoWidth = 50
      const logoHeight =
        (logoWidth * response.data.byteLength) / logoData.length
      const logoX = pageWidth - logoWidth - 10
      const logoY = 10

      doc.addImage(logoData, 'PNG', logoX, logoY, logoWidth, logoHeight)

      const leftMargin = 10
      let y = logoY

      doc.setFontSize(16)
      doc.text('Detalles del Pedido', leftMargin, y)
      y += 10

      doc.setFontSize(12)
      doc.text(`Cliente: ${user.fullName}`, leftMargin, y)
      y += 6
      doc.text(`Dirección de entrega: ${user.address}`, leftMargin, y)
      y += 6
      doc.text(`Teléfono: ${user.phoneNumber}`, leftMargin, y)
      y += 6
      doc.text(`Fecha: ${new Date().toLocaleDateString()}`, leftMargin, y)
      y += 6
      doc.text(`No. de Orden: ${orderNumber}`, leftMargin, y)
      y += 18

      doc.autoTable({
        head: [
          [
            'Producto/Mercancia',
            'Unidad',
            'Cantidad',
            'Condición',
            'Bruto',
            'Neto',
            'Precio',
            'Estado',
          ],
        ],
        body: order.items.map((item) => [
          item.producto || '',
          item.unidad || '',
          item.cantidad || '',
          item.option || '',
          '',
          '',
          '',
          '',
        ]),
        startY: y,
        styles: { lineWidth: 0.1, lineColor: [0, 0, 0], fontSize: 10 },
        headStyles: {
          fillColor: [255, 255, 255],
          textColor: [0, 0, 0],
          fontStyle: 'bold',
          lineWidth: 0.1,
        },
        alternateRowStyles: { fillColor: [240, 240, 240] },
        tableWidth: 'auto',
        margin: { left: leftMargin, right: leftMargin },
      })

      y = doc.autoTable.previous.finalY + 10

      doc.setFontSize(12)
      doc.text('Observaciones:', leftMargin, y)
      y += 5
      const textWidth = pageWidth - leftMargin * 2
      const textHeight = 30
      doc.setDrawColor(0, 0, 0)
      doc.rect(leftMargin, y, textWidth, textHeight)
      doc.text(order.observations || '', leftMargin + 2, y + 10)

      const pdfFileName = `${orderNumber}_${user.fullName.replace(
        /\s+/g,
        '_'
      )}.pdf`
      pdfPath = path.join(os.tmpdir(), pdfFileName)
      doc.save(pdfPath)

      const destination = `orders/${pdfFileName}`
      await storage
        .bucket('mambo-fresh-app-2a0b9.appspot.com')
        .upload(pdfPath, { destination })

      const file = storage
        .bucket('mambo-fresh-app-2a0b9.appspot.com')
        .file(destination)
      const [pdfUrl] = await file.getSignedUrl({
        action: 'read',
        expires: '03-01-2500',
      })

      const msg = {
        to: user.email,
        cc: 'pedidos@mambofresh.es',
        from: 'pedidos@mambofresh.es',
        subject: `Nuevo pedido ${orderNumber} ${user.fullName}`,
        html: `
          <p>Hola ${user.fullName},</p>
          <p>Adjuntamos el PDF con los detalles de su pedido:</p>
          <p><a href="${pdfUrl}" style="display:inline-block;padding:10px 20px;font-size:16px;color:#ffffff;background-color:#007bff;text-decoration:none;border-radius:5px;">Descargar PDF</a></p>
          <p>Gracias por su pedido,<br>Mambo Fresh</p>
        `,
      }

      await sgMail.send(msg)
      console.log('Email sent!')
    } catch (error) {
      console.error('Error in sendOrderEmail function:', error)
    } finally {
      if (pdfPath && fs.existsSync(pdfPath)) {
        fs.unlinkSync(pdfPath)
      }
    }
  })

// Función para generar y enviar el reporte de corte en PDF
exports.generateCutReport = functions.database
  .ref('/cutsInProgress/{cutId}')
  .onCreate(async (snapshot, context) => {
    let pdfPathGeneral
    const logoY = 10

    try {
      const cutId = context.params.cutId
      const ordersData = snapshot.val().orders

      if (!ordersData || Object.keys(ordersData).length === 0) {
        console.log('No hay pedidos en el corte.')
        return
      }

      const ordersToInclude = Object.values(ordersData).filter((order) =>
        Array.isArray(order.items)
      )

      if (ordersToInclude.length === 0) {
        console.log('No hay pedidos que cumplan las condiciones para el corte.')
        return
      }

      const logoUrl =
        'https://sorpresasmagicodia.com/wp-content/uploads/2024/06/MAMBO_APP_2024.png'
      let logoData, logoWidth, logoHeight

      try {
        const response = await axios.get(logoUrl, {
          responseType: 'arraybuffer',
        })

        if (response.status === 200) {
          logoData = Buffer.from(response.data, 'binary').toString('base64')
          logoWidth = 50
          logoHeight = (logoWidth * response.data.byteLength) / logoData.length
        }

        const doc = new jsPDF()
        const pageWidth = doc.internal.pageSize.getWidth()
        const leftMargin = 10

        if (logoData) {
          const logoX = pageWidth - logoWidth - 10
          doc.addImage(logoData, 'PNG', logoX, logoY, logoWidth, logoHeight)
        }

        let y = logoY + (logoHeight || 0) + 10
        doc.setFontSize(16)
        doc.text(`Resumen de Corte ${cutId}`, pageWidth / 2, y, {
          align: 'center',
        })
        y += 15

        const groupedItems = {}
        for (const order of ordersToInclude) {
          for (const item of order.items) {
            const key = `${item.producto}-${item.unidad}-${item.option}`
            if (!groupedItems[key]) {
              groupedItems[key] = { ...item, cantidad: 0 }
            }
            groupedItems[key].cantidad += parseInt(item.cantidad, 10) || 0
          }
        }

        doc.autoTable({
          head: [['Producto/Mercancia', 'Unidad', 'Cantidad', 'Condición']],
          body: Object.values(groupedItems).map((item) => [
            item.producto || '',
            item.unidad || '',
            item.cantidad || '',
            item.option || '',
          ]),
          startY: y,
          styles: { lineWidth: 0.1, lineColor: [0, 0, 0], fontSize: 10 },
          headStyles: {
            fillColor: [255, 255, 255],
            textColor: [0, 0, 0],
            fontStyle: 'bold',
            lineWidth: 0.1,
          },
          alternateRowStyles: { fillColor: [240, 240, 240] },
          tableWidth: 'auto',
          margin: { left: leftMargin, right: leftMargin },
        })

        const pdfFileName = `corte_${cutId}.pdf`
        pdfPathGeneral = path.join(os.tmpdir(), pdfFileName)
        doc.save(pdfPathGeneral)

        const destination = `cuts/${pdfFileName}`
        await storage
          .bucket('mambo-fresh-app-2a0b9.appspot.com')
          .upload(pdfPathGeneral, { destination })

        const file = storage
          .bucket('mambo-fresh-app-2a0b9.appspot.com')
          .file(destination)
        const [pdfUrl] = await file.getSignedUrl({
          action: 'read',
          expires: '03-01-2500',
        })

        const msg = {
          to: 'pedidos@mambofresh.es',
          from: 'pedidos@mambofresh.es',
          subject: `Corte ${cutId} generado`,
          html: `<p>Resumen de corte generado. Puede descargar el PDF desde el siguiente enlace:</p>
                 <p><a href="${pdfUrl}">Descargar PDF del corte</a></p>`,
        }

        await sgMail.send(msg)
        console.log('Reporte de corte enviado!')
      } catch (error) {
        console.error('Error generando o enviando el reporte de corte:', error)
      }
    } finally {
      if (pdfPathGeneral && fs.existsSync(pdfPathGeneral)) {
        fs.unlinkSync(pdfPathGeneral)
      }
    }
  })
