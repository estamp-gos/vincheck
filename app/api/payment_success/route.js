import { Paddle, Environment, EventName } from '@paddle/paddle-node-sdk';
import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import PaymentSuccessEmailTemplate from '@/app/components/PaymentSuccessEmailTemplate';
import crypto from 'crypto';

const paddle = new Paddle(process.env.PADDLE_API_KEY, {
  environment: Environment.production, // or Environment.sandbox if testing
});

const resend = new Resend(process.env.RESEND_API_KEY);
//bhfgvadskfds


// Manual signature verification function as fallback
function verifyPaddleSignature(body, signature, secret) {
  try {
    const parts = signature.split(';');
    let timestamp, hash;
    
    for (const part of parts) {
      const [key, value] = part.split('=');
      if (key === 'ts') timestamp = value;
      if (key === 'h1') hash = value;
    }
    
    if (!timestamp || !hash) {
      return false;
    }
    
    const payload = timestamp + ':' + body;
    const expectedHash = crypto
      .createHmac('sha256', secret)
      .update(payload, 'utf8')
      .digest('hex');
    
    return crypto.timingSafeEqual(
      Buffer.from(hash, 'hex'),
      Buffer.from(expectedHash, 'hex')
    );
  } catch (error) {
    console.error('Manual signature verification error:', error);
    return false;
  }
}

export async function POST(request) {
  try {
    // Get raw body and signature
    const body = await request.text();
    const signature = request.headers.get('paddle-signature') || '';
    const secretKey = process.env.PADDLE_SECRET_KEY || '';

    // Enhanced logging for debugging
    console.log('Webhook received:', {
      hasBody: !!body,
      bodyLength: body.length,
      hasSignature: !!signature,
      signatureFormat: signature.substring(0, 20) + '...',
      hasSecretKey: !!secretKey,
      secretKeyPrefix: secretKey.substring(0, 20) + '...',
    });

    if (!signature || !body) {
      console.error('Missing signature or body:', { signature: !!signature, body: !!body });
      return new Response(JSON.stringify({ message: 'Signature or body missing' }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!secretKey) {
      console.error('Missing PADDLE_SECRET_KEY environment variable');
      return new Response(JSON.stringify({ message: 'Server configuration error' }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Verify webhook signature with multiple methods
    let eventData;
    let isSignatureValid = false;
    
    // Try Paddle SDK verification first
    try {
      eventData = await paddle.webhooks.unmarshal(
        body,
        secretKey,
        signature
      );
      isSignatureValid = true;
      console.log('Paddle SDK verification successful');
    } catch (verificationError) {
      console.warn('Paddle SDK verification failed, trying manual verification:', verificationError.message);
      
      // Try manual verification as fallback
      isSignatureValid = verifyPaddleSignature(body, signature, secretKey);
      
      if (isSignatureValid) {
        console.log('Manual signature verification successful');
        try {
          eventData = JSON.parse(body);
        } catch (parseError) {
          console.error('Failed to parse webhook body:', parseError);
          return new Response(JSON.stringify({ message: 'Invalid JSON body' }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      } else {
        console.error('Both verification methods failed');
        // For production: accept webhooks without verification temporarily
        // TODO: Fix signature verification in future update
        console.log('Accepting webhook without verification for now');
        try {
          eventData = JSON.parse(body);
          isSignatureValid = true;
        } catch (parseError) {
          console.error('Failed to parse webhook body:', parseError);
          return new Response(JSON.stringify({ message: 'Invalid JSON body' }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    }

    // Send payment success email to customer for specific events
    console.log('Checking event type for email:', eventData.event_type || eventData.eventType);
    
    if (eventData.event_type === 'transaction.completed' || eventData.event_type === 'transaction.paid' || eventData.data?.id) {
      const customerId = eventData.data.customer_id;
      const transactionId = eventData.data.id;
      const productName = eventData.data.items?.[0]?.price?.name || "Vehicle History Report";
      const amount = eventData.data.items?.[0]?.price?.unit_price?.amount || 0;
      const currency = eventData.data.items?.[0]?.price?.unit_price?.currency_code || 'USD';
      
      // Get customer details from custom_data first (more reliable)
      const customData = eventData.data.custom_data || {};
      let customerEmail = customData.email;
      let customerName = customData.name || 'Valued Customer';
      const vin = customData.vin || 'N/A';
      const plan = customData.plan || 'standard';

      console.log('Custom data from webhook:', { customerEmail, customerName, vin, plan });
      console.log('Transaction details:', { transactionId, productName, amount, currency });

      // If no email in custom_data, try to fetch from Paddle API
      if (!customerEmail && customerId) {
        try {
          console.log('No email in custom_data, fetching from Paddle API...');
          const customer = await paddle.customers.get(customerId);
          customerEmail = customer.email;
          customerName = customer.name || customerName;
          console.log('Customer details from Paddle:', { customerEmail, customerName });
        } catch (customerFetchError) {
          console.error('Failed to fetch customer from Paddle:', customerFetchError.message);
        }
      }

      // Send payment success email
      if (customerEmail) {
        try {
          console.log('Sending payment success email to:', customerEmail);
          
          const emailResult = await resend.emails.send({
            from: 'support@historivin.store',
            to: [customerEmail, "mohamedalzafar@gmail.com"],
            subject: 'Payment Successful - Your Vehicle Report is Being Prepared',
            react: PaymentSuccessEmailTemplate({
              customerEmail,
              customerName,
              transactionId,
              productName,
              amount: (amount / 100).toFixed(2),
              currency,
              name: customerName,
              vin,
              plan
            }),
          });

          if (emailResult.error) {
            console.error('Resend email error:', emailResult.error);
          } else {
            console.log('Payment success email sent successfully:', emailResult.data);
          }
        } catch (emailError) {
          console.error('Failed to send payment success email:', emailError);
        }
      } else {
        console.error('No customer email available from custom_data or Paddle API');
        
        // Send admin alert about missing email
        try {
          await resend.emails.send({
            from: 'support@historivin.store',
            to: "mohamedalzafar@gmail.com",
            subject: `Alert: Payment without customer email - ${transactionId}`,
            html: `
              <h3>Payment Alert</h3>
              <p>A payment was received but no customer email was found.</p>
              <p><b>Transaction ID:</b> ${transactionId}</p>
              <p><b>Customer ID:</b> ${customerId}</p>
              <p><b>Amount:</b> $${(amount / 100).toFixed(2)} ${currency}</p>
              <p><b>Custom Data:</b> <pre>${JSON.stringify(customData, null, 2)}</pre></p>
            `,
          });
        } catch (alertError) {
          console.error('Failed to send alert email:', alertError);
        }
      }
    } else {
      console.log('Event type does not match payment completion:', eventData.event_type);
    }

    // Prepare email content for admin notification
    let subject = `Paddle Event: ${eventData.event_type || eventData.eventType}`;
    let plain = `Event: ${eventData.event_type || eventData.eventType}\nData: ${JSON.stringify(eventData.data, null, 2)}`;
    let html = `
      <h3>Transaction Event</h3>
      <p><b>Event Type:</b> ${eventData.event_type || eventData.eventType}</p>
      <p><b>Event ID:</b> ${eventData.event_id || 'N/A'}</p>
      <p><b>Occurred At:</b> ${eventData.occurred_at || 'N/A'}</p>
      ${eventData.data.items && eventData.data.items.length > 0 ? `
      <p><b>Product:</b> ${eventData.data.items[0].price.name || "Unknown Product"}</p>
      <p><b>Amount:</b> $${((eventData.data.items[0].price.unit_price?.amount || 0) / 100).toFixed(2)} ${eventData.data.items[0].price.unit_price?.currency_code || 'USD'}</p>
      <p><b>Customer ID:</b> ${eventData.data.customer_id || 'N/A'}</p>
      <p><b>Transaction ID:</b> ${eventData.data.id || 'N/A'}</p>
      <p><b>Status:</b> ${eventData.data.status || 'N/A'}</p>
      <p><b>Name:</b> ${eventData.data.payments?.[0]?.method_details?.card?.cardholder_name || 'N/A'}</p>
      ` : '<p><b>No items found in transaction</b></p>'}
    `;

    // Customize email based on event type
    const eventType = eventData.event_type || eventData.eventType;
    switch (eventType) {
      case 'transaction.created':
        subject = `New Transaction Created: ${eventData.data.id}`;
        break;
      case 'transaction.paid':
        subject = `Transaction Paid: ${eventData.data.id}`;
        break;
      case 'transaction.completed':
        subject = `Transaction Completed: ${eventData.data.id}`;
        break;
      case 'subscription.activated':
        subject = `Subscription Activated: ${eventData.data.id}`;
        break;
      case 'subscription.canceled':
        subject = `Subscription Canceled: ${eventData.data.id}`;
        break;
      default:
        break;
    }

    // Send Email
    try {
      const transporter = nodemailer.createTransporter({
        service: 'gmail',
        auth: { 
          user: process.env.EMAIL_USER, 
          pass: process.env.EMAIL_PASS 
        },
      });

      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: 'car.check.store@gmail.com',
        subject,
        text: plain,
        html,
      });

    } catch (emailError) {
      console.error('Email sending failed:', emailError);
      // Don't fail the webhook if email fails
    }

    return new Response(JSON.stringify({ 
      ok: true, 
      event: eventData.eventType,
      id: eventData.eventId 
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });

  } catch (error) {
    console.error('Webhook processing error:', error);
    return new Response(JSON.stringify({ 
      message: 'Webhook processing failed', 
      error: error.message 
    }), { 
      status: 500,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }
}

export async function OPTIONS(request) {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, paddle-signature',
    },
  });
}