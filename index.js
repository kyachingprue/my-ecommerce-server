const express = require('express');
const cors = require('cors');
require('dotenv').config();
const app = express();
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const port = process.env.PORT || 4000;
const stripe = require('stripe')(process.env.PAYMENT_GATEWAY_KEY);

app.use(
  cors({
    origin: 'http://localhost:5173',
    credentials: true,
  })
);
app.use(express.json());

const serviceAccount = require('./firebase-admin-key.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.nhw49.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    // Send a ping to confirm a successful connection
    await client.db('admin').command({ ping: 1 });
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    );

    const productCollection = client.db('greenBasket').collection('products');
    const ordersCollection = client.db('greenBasket').collection('orders');
    const paymentCollection = client.db('greenBasket').collection('payments');
    const usersCollection = client.db('greenBasket').collection('users');
    const sellerRequestsCollection = client
      .db('greenBasket')
      .collection('seller-requests');

    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;

      if (!authHeader) {
        return res.status(401).send({ message: 'Unauthorized access' });
      }
      const token = authHeader.split(' ')[1];
      if (!token) {
        return res.status(401).send({ message: 'Unauthorized access' });
      }
      // verify token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: 'Forbidden access' });
      }
    };

    app.get('/products', async (req, res) => {
      try {
        const { sellerEmail, search, category, sortBy, sortOrder } = req.query;
        let query = {};

        // ✅ Filter by seller email
        if (sellerEmail) {
          query['seller.email'] = sellerEmail;
        }

        // ✅ Search filter (title, category, description, seller name, tags)
        if (search) {
          const searchRegex = new RegExp(search, 'i');
          query.$or = [
            { title: searchRegex },
            { category: searchRegex },
            { description: searchRegex },
            { 'seller.name': searchRegex },
            { tags: { $in: [searchRegex] } },
          ];
        }

        // ✅ Category filter
        if (category) {
          query.category = category;
        }

        // ✅ Sorting system
        let sortOption = {};

        if (sortBy) {
          switch (sortBy) {
            case 'price':
              sortOption.price = sortOrder === 'desc' ? -1 : 1;
              break;
            case 'title':
              sortOption.title = sortOrder === 'desc' ? -1 : 1;
              break;
            case 'releaseDate':
              sortOption.releaseDate = sortOrder === 'desc' ? -1 : 1;
              break;
            default:
              break;
          }
        }

        // ✅ Find & sort products
        const result = await productCollection
          .find(query)
          .sort(sortOption)
          .toArray();

        res.send(result);
      } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).send({
          success: false,
          message: 'Internal server error',
        });
      }
    });

    // ✅ GET product by ID
    app.get('/products/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const product = await productCollection.findOne(query);

        if (!product) {
          return res
            .status(404)
            .send({ success: false, message: 'Product not found' });
        }

        res.send(product);
      } catch (error) {
        console.error('Error fetching product:', error);
        res
          .status(500)
          .send({ success: false, message: 'Internal server error' });
      }
    });

    app.post('/products', async (req, res) => {
      const product = req.body;
      const result = await productCollection.insertOne(product);
      res.send(result);
    });

    app.patch('/products/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const updatedProduct = req.body;
        const query = { _id: new ObjectId(id) };
        const updateDoc = { $set: updatedProduct };

        const result = await productCollection.updateOne(query, updateDoc);
        res.send(result);
      } catch (error) {
        console.error('Error updating product:', error);
        res
          .status(500)
          .send({ success: false, message: 'Internal server error' });
      }
    });

    app.delete('/products/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await productCollection.deleteOne(query);
      res.send(result);
    });

    // user role AIP
    app.get('/users', async (req, res) => {
      try {
        const users = await usersCollection.find({}).toArray();
        res.status(200).json(users);
      } catch (error) {
        console.error('Error fetching users:', error);
        res
          .status(500)
          .json({ success: false, message: 'Failed to fetch users' });
      }
    });

    app.get('/users/:email', async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      res.send(user || {});
    });

    app.post('/users', async (req, res) => {
      const email = req.body.email;
      const userExists = await usersCollection.findOne({ email });
      if (userExists) {
        return res
          .status(200)
          .send({ message: 'User already exists', insertedId: false });
      }
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // Create PaymentIntent
    app.post('/create-payment-intent', verifyFBToken, async (req, res) => {
      try {
        const { productId } = req.body;
        const product = await productCollection.findOne({
          _id: new ObjectId(productId),
        });

        if (!product)
          return res.status(404).json({ error: 'Product not found' });

        const amount = Math.round(product.price * 100);

        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: (product.currency || 'bdt').toLowerCase(),
          payment_method_types: ['card'],
          metadata: {
            productId: product._id.toString(),
            productTitle: product.title,
          },
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (err) {
        console.error('create-payment-intent error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Get payment history for a user (descending)
    app.get('/payments/:email', verifyFBToken, async (req, res) => {
      try {
        const email = req.params.email;
        if (req.decoded.email !== email) {
          return res.status(403).send({ message: 'Forbidden access' });
        }
        const payments = await paymentCollection
          .find({ user_email: email })
          .sort({ createdAt: -1 })
          .toArray();

        res.json({ success: true, data: payments });
      } catch (err) {
        console.error('Error fetching user payments:', err);
        res
          .status(500)
          .json({ success: false, message: 'Internal server error' });
      }
    });

    // Save Payment Info & Update Product
    app.post('/payments', verifyFBToken, async (req, res) => {
      try {
        const { productId, userEmail, amount, paymentIntentId } = req.body;

        // Find product
        const product = await productCollection.findOne({
          _id: new ObjectId(productId),
        });
        if (!product)
          return res
            .status(404)
            .json({ success: false, message: 'Product not found' });

        // ✅ Update product payment_status
        await productCollection.updateOne(
          { _id: new ObjectId(productId) },
          { $set: { payment_status: 'paid' } }
        );

        // ✅ Update order status for this user and product
        await ordersCollection.updateOne(
          { productId: productId, user_email: userEmail },
          { $set: { status: 'confirmed', order_status: 'paid' } }
        );

        // ✅ Save payment record
        const paymentDoc = {
          productId,
          title: product.title,
          amount,
          currency: product.currency || 'BDT',
          user_email: userEmail,
          paymentIntentId,
          status: 'succeeded',
          createdAt_string: new Date().toISOString(),
          createdAt: new Date(),
        };

        const result = await paymentCollection.insertOne(paymentDoc);

        res.status(200).json({
          success: true,
          message: 'Payment recorded successfully',
          paymentId: result.insertedId,
        });
      } catch (err) {
        console.error('Error saving payment:', err);
        res
          .status(500)
          .json({ success: false, message: 'Internal server error' });
      }
    });

    // My Orders API
    app.get('/orders', verifyFBToken, async (req, res) => {
      try {
        const email = req.query.email;
        const query = email ? { user_email: email } : {};
        const result = await ordersCollection.find(query).toArray();
        res.send(result);
      } catch (error) {
        console.error('Error fetching orders:', error);
        res
          .status(500)
          .send({ success: false, message: 'Failed to fetch orders' });
      }
    });

    // GET tracked products for a user
    app.get('/track-products/:email', async (req, res) => {
      try {
        const email = req.params.email;

        // Fetch payments
        const payments = await paymentCollection
          .find({ user_email: email })
          .sort({ createdAt: -1 })
          .toArray();

        // Combine with product info & order status
        const trackedProducts = await Promise.all(
          payments.map(async payment => {
            const product = await productCollection.findOne({
              _id: new ObjectId(payment.productId),
            });
            const order = await ordersCollection.findOne({
              productId: payment.productId,
              user_email: email,
            });

            return {
              _id: payment._id,
              productTitle: product?.title || 'Unknown',
              productImage: product?.image || '',
              price: payment.amount,
              currency: payment.currency,
              paymentStatus: payment.status,
              orderStatus: order?.status || 'Pending',
              createdAt: payment.createdAt_string,
            };
          })
        );

        res.json({ success: true, data: trackedProducts });
      } catch (err) {
        console.error(err);
        res
          .status(500)
          .json({ success: false, message: 'Internal server error' });
      }
    });

    app.post('/orders', async (req, res) => {
      try {
        const orderData = req.body; // data from frontend
        const result = await ordersCollection.insertOne(orderData);
        res.status(201).json({ success: true, result });
      } catch (error) {
        console.error(error);
        res
          .status(500)
          .json({ success: false, message: 'Failed to add order' });
      }
    });

    app.patch('/orders/:id', async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = { $set: { status } };

      const result = await ordersCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    // Get all seller requests (Admin panel)
    app.get('/seller-requests', async (req, res) => {
      const requests = await sellerRequestsCollection.find().toArray();
      res.send(requests);
    });

    // Get all orders for a seller (CustomerOrders for Seller Dashboard)
    app.get('/seller-orders/:sellerEmail', async (req, res) => {
      try {
        const sellerEmail = req.params.sellerEmail;

        // Get all products sold by this seller
        const sellerProducts = await productCollection
          .find({ 'seller.email': sellerEmail })
          .project({ _id: 1, title: 1 }) // only need _id and title
          .toArray();

        const productIds = sellerProducts.map(p => p._id.toString());

        // Get orders for these products
        const orders = await ordersCollection
          .find({ productId: { $in: productIds } })
          .toArray();

        // Attach product title to each order
        const enrichedOrders = orders.map(order => {
          const product = sellerProducts.find(
            p => p._id.toString() === order.productId
          );
          return {
            ...order,
            productTitle: product?.title || 'Unknown Product',
          };
        });

        res.json({ success: true, data: enrichedOrders });
      } catch (error) {
        console.error('Error fetching seller orders:', error);
        res
          .status(500)
          .json({ success: false, message: 'Internal server error' });
      }
    });

    app.post('/seller-requests', async (req, res) => {
      try {
        const { email, name, message, status, requested_at } = req.body;

        // Check if user already submitted a request
        const existingRequest = await sellerRequestsCollection.findOne({
          email,
        });
        if (existingRequest) {
          return res.status(200).json({
            success: false,
            message: 'You have already submitted a seller request.',
          });
        }

        const result = await sellerRequestsCollection.insertOne({
          email,
          name,
          message,
          status: status || 'pending',
          requested_at: requested_at || new Date().toISOString(),
        });

        res.status(201).json({
          success: true,
          message: 'Seller request submitted successfully.',
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error('Error submitting seller request:', error);
        res
          .status(500)
          .json({ success: false, message: 'Internal server error' });
      }
    });

    // Update seller request status (Admin)
    app.patch('/seller-requests/:id', async (req, res) => {
      const id = req.params.id;
      const { status } = req.body; // "approved" or "rejected"

      const result = await sellerRequestsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } }
      );

      // ✅ If approved → update user role to "seller"
      if (status === 'approved') {
        const request = await sellerRequestsCollection.findOne({
          _id: new ObjectId(id),
        });
        await usersCollection.updateOne(
          { email: request.email },
          { $set: { role: 'seller' } },
          { upsert: true }
        );
      }

      res.send({
        success: true,
        message: 'Status updated successfully',
        result,
      });
    });

    app.delete('/users/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await usersCollection.deleteOne(query);

        if (result.deletedCount > 0) {
          res.send({
            success: true,
            message: 'User deleted',
            deletedCount: result.deletedCount,
          });
        } else {
          res.status(404).send({ success: false, message: 'User not found' });
        }
      } catch (error) {
        console.error('Error deleting user:', error);
        res
          .status(500)
          .send({ success: false, message: 'Failed to delete user' });
      }
    });

    app.delete('/orders/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await ordersCollection.deleteOne(query);
        res.send({ success: true, message: 'Order deleted', data: result });
      } catch (error) {
        console.error('Error deleting order:', error);
        res
          .status(500)
          .send({ success: false, message: 'Failed to delete order' });
      }
    });
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
